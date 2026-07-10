const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// API Key などの環境変数は .env.local から読み込む
require('dotenv').config({ path: '.env.local' });

const app = express();
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USER_REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const ANALYSIS_CACHE_FILE = path.join(DATA_DIR, 'analysis-cache.json');
const MAX_USER_REVIEW_LENGTH = 1200;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const USE_POSTGRES = Boolean(process.env.DATABASE_URL);
const reviewRateLimits = new Map();
let pgPool;
let pgReadyPromise;

app.use(express.json());
app.use(express.static('public'));

// ===== 設定 =====
// 利用するLLMプロバイダを選択します（'openai' または 'gemini'）
const PROVIDER = 'openai';

// プロバイダごとに利用するモデル
const MODELS = {
    openai: 'gpt-5.5',        // OpenAI（デフォルト）
    gemini: 'gemini-3.5-flash', // Google Gemini
};
const MODEL = MODELS[PROVIDER];

let promptTemplate;
try {
    promptTemplate = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');
} catch (error) {
    console.error('Error reading prompt.md:', error);
    process.exit(1);
}

const OPENAI_API_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';

app.get('/api/user-reviews', async (req, res) => {
    try {
        const courseName = String(req.query.courseName || '').trim();
        const schoolName = String(req.query.schoolName || '').trim();
        const reviews = await listUserReviews(courseName, schoolName);
        const stats = await getUserReviewStats(courseName, schoolName);
        res.json({
            reviews,
            stats,
        });
    } catch (error) {
        console.error('User Review Read Error:', error);
        res.status(500).json({ error: 'Failed to load user reviews.' });
    }
});

app.post('/api/user-reviews', async (req, res) => {
    try {
        const review = normalizeUserReview(req.body);
        await assertCanSubmitReview(req, review);
        await saveUserReview(review);
        res.status(201).json({ review });
    } catch (error) {
        const status = error.statusCode || 500;
        if (status >= 500) {
            console.error('User Review Save Error:', error);
        }
        res.status(status).json({ error: error.message || 'Failed to save user review.' });
    }
});

app.post('/api/user-reviews/:id/helpful', async (req, res) => {
    try {
        const review = await markReviewHelpful(req.params.id);
        res.json({ review });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message || 'Failed to update review.' });
    }
});

app.post('/api/user-reviews/:id/report', async (req, res) => {
    try {
        const review = await reportUserReview(req.params.id);
        res.json({ review });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message || 'Failed to report review.' });
    }
});

app.delete('/api/user-reviews/:id', async (req, res) => {
    try {
        requireAdmin(req);
        await deleteUserReview(req.params.id);
        res.json({ ok: true });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message || 'Failed to delete review.' });
    }
});

app.get('/api/courses', async (req, res) => {
    try {
        const filters = normalizeCourseFilters(req.query);
        const courses = await listCourses(filters);
        res.json({ courses });
    } catch (error) {
        console.error('Course List Error:', error);
        res.status(500).json({ error: 'Failed to load courses.' });
    }
});

app.get('/api/recommendations', async (req, res) => {
    try {
        const priority = String(req.query.priority || 'ラクさ重視');
        const courses = await listRecommendedCourses(priority);
        res.json({ courses });
    } catch (error) {
        console.error('Recommendation Error:', error);
        res.status(500).json({ error: 'Failed to load recommendations.' });
    }
});

app.post('/api/compare', async (req, res) => {
    try {
        const courses = Array.isArray(req.body.courses) ? req.body.courses.slice(0, 4) : [];
        const compared = await Promise.all(courses.map(async (course) => {
            const courseName = String(course.courseName || '').trim();
            const schoolName = String(course.schoolName || '').trim();
            return {
                courseName,
                schoolName,
                stats: await getUserReviewStats(courseName, schoolName),
            };
        }));
        res.json({ courses: compared.filter(course => course.courseName) });
    } catch (error) {
        console.error('Compare Error:', error);
        res.status(500).json({ error: 'Failed to compare courses.' });
    }
});

app.get('/api/reviews', async (req, res) => {
    try {
        const courseName = String(req.query.courseName || '').trim();
        const schoolName = String(req.query.schoolName || '').trim();

        if (!courseName) {
            return res.status(400).json({ error: 'courseName is required' });
        }

        const reviews = await searchCourseReviews(courseName, schoolName);
        res.json({
            courseName,
            schoolName,
            reviews,
        });
    } catch (error) {
        console.error('Review Search Error:', error);
        res.status(500).json({ error: 'Failed to search course reviews. Please paste reviews manually.' });
    }
});

// 分析件数の上限（過剰なリクエストでトークンを浪費しないようにする）
const MAX_COUNT = 20;

app.post('/api/', async (req, res) => {
    try {
        // title と、変数置換に使うその他のキーを受け取る
        // （prompt.md がプロンプトを定義するので、リクエストでの上書きは許可しない）
        const { title = '講義レビュー分析', ...variables } = req.body;

        // count が指定されている場合は 1〜MAX_COUNT の範囲に収める
        if (variables.count !== undefined) {
            const count = Number(variables.count);
            if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
                return res.status(400).json({
                    error: `count must be an integer between 1 and ${MAX_COUNT}`,
                });
            }
        }

        // prompt.md のテンプレート変数 ${key} をリクエストの値で置換する
        const finalPrompt = fillTemplate(promptTemplate, variables);
        const cacheKey = hashValue(JSON.stringify({ provider: PROVIDER, model: MODEL, prompt: finalPrompt }));
        const cachedResult = await getCachedAnalysis(cacheKey);

        if (cachedResult) {
            return res.json({
                title: title,
                data: cachedResult,
                rawData: JSON.stringify(cachedResult),
                cached: true,
            });
        }

        let result;
        if (PROVIDER === 'openai') {
            result = await callOpenAI(finalPrompt);
        } else if (PROVIDER === 'gemini') {
            result = await callGemini(finalPrompt);
        } else {
            return res.status(400).json({ error: 'Invalid provider configuration' });
        }

        await saveCachedAnalysis(cacheKey, result);

        res.json({
            title: title,
            data: result,
            rawData: JSON.stringify(result),
            cached: false,
        });

    } catch (error) {
        // 詳細はサーバーログにのみ出力し、クライアントには汎用メッセージを返す
        console.error('API Error:', error);
        res.status(500).json({ error: 'Failed to generate content. Please try again.' });
    }
});

// prompt.md 内の ${key} を variables の値で安全に置換する
function fillTemplate(template, variables) {
    return template.replace(/\$\{(\w+)\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(variables, key)
            ? String(variables[key])
            : match; // 対応する値がなければそのまま残す
    });
}

async function callOpenAI(prompt) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    const response = await fetch(OPENAI_API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: MODEL,
            messages: [
                { role: 'system', content: prompt }
            ],
            max_completion_tokens: 2000,
            response_format: { type: "json_object" }
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'OpenAI API error');
    }

    const data = await response.json();
    const responseText = data.choices[0].message.content;
    return extractArray(responseText);
}

async function callGemini(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY environment variable is not set');
    }

    const response = await fetch(`${GEMINI_API_BASE_URL}${MODEL}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            contents: [{
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                maxOutputTokens: 3000,
                response_mime_type: "application/json"
            }
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Gemini API error');
    }

    const data = await response.json();
    const responseText = data.candidates[0].content.parts[0].text;
    return extractArray(responseText);
}

// LLM が返した JSON 文字列をパースし、最初に見つかった配列を取り出す
function extractArray(responseText) {
    let parsedData;
    try {
        parsedData = JSON.parse(responseText);
    } catch (parseError) {
        throw new Error('Failed to parse LLM response: ' + parseError.message);
    }

    const arrayData = Object.values(parsedData).find(Array.isArray);
    if (!arrayData) {
        throw new Error('No array found in the LLM response object.');
    }
    return arrayData;
}

async function searchCourseReviews(courseName, schoolName) {
    const terms = [
        schoolName,
        courseName,
        '講義',
        '口コミ',
        '授業評価',
        'シラバス',
    ].filter(Boolean).join(' ');

    const url = new URL('https://html.duckduckgo.com/html/');
    url.searchParams.set('q', terms);

    const response = await fetch(url, {
        headers: {
            'User-Agent': 'generic-webapi-course-review/1.0',
        },
    });

    if (!response.ok) {
        throw new Error(`Review search failed: ${response.status}`);
    }

    const html = await response.text();
    const results = parseSearchResults(html).slice(0, 5);
    return Promise.all(results.map((result, index) => {
        return index < 3 ? enrichSearchResult(result) : result;
    }));
}

async function enrichSearchResult(result) {
    if (result.snippet && result.snippet.length > 80) {
        return result;
    }

    const pageText = await fetchPageSummary(result.link);
    return {
        ...result,
        snippet: pageText || result.snippet,
    };
}

async function fetchPageSummary(link) {
    try {
        const response = await fetch(link, {
            headers: {
                'User-Agent': 'generic-webapi-course-review/1.0',
            },
            signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
            return '';
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
            return '';
        }

        const html = await response.text();
        return stripHtml(decodeXml(html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')))
            .slice(0, 900);
    } catch (error) {
        return '';
    }
}

function parseSearchResults(html) {
    const blocks = html.match(/<div class="result[\s\S]*?(?=<div class="result|\s*<\/body>)/g) || [];

    return blocks.map((block) => {
        const titleMatch = block.match(/class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)
            || block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/div>/);

        if (!titleMatch) {
            return null;
        }

        const link = normalizeSearchUrl(decodeXml(titleMatch[1]));
        const title = stripHtml(decodeXml(titleMatch[2]));
        const snippet = snippetMatch ? stripHtml(decodeXml(snippetMatch[1])) : '';

        return {
            title,
            snippet,
            link,
        };
    }).filter(result => result && result.title && result.link);
}

function normalizeSearchUrl(value) {
    const withProtocol = value.startsWith('//') ? `https:${value}` : value;

    try {
        const url = new URL(withProtocol);
        const redirected = url.searchParams.get('uddg');
        return redirected ? decodeURIComponent(redirected) : withProtocol;
    } catch (error) {
        return withProtocol;
    }
}

function stripHtml(value) {
    return value
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function decodeXml(value) {
    return value
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

async function readUserReviews() {
    try {
        const content = await fs.promises.readFile(USER_REVIEWS_FILE, 'utf8');
        const parsed = JSON.parse(content);
        return Array.isArray(parsed) ? parsed.map(normalizeStoredReview) : [];
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

async function listUserReviews(courseName, schoolName) {
    if (USE_POSTGRES) {
        const pool = await getPgPool();
        const query = buildReviewFilterQuery(courseName, schoolName);
        const result = await pool.query(
            `SELECT id, course_name, school_name, reviewer_name, rating, difficulty, attendance,
                    year, term, instructor, user_id, helpful_count, report_count, text, created_at
             FROM user_reviews
             ${query.where}
             ORDER BY helpful_count DESC, created_at DESC
             LIMIT 50`,
            query.values
        );
        return result.rows.map(rowToUserReview);
    }

    const reviews = await readUserReviews();
    return filterUserReviews(reviews, courseName, schoolName, 50);
}

async function saveUserReview(review) {
    if (USE_POSTGRES) {
        const pool = await getPgPool();
        await pool.query(
            `INSERT INTO user_reviews (
                id, course_name, course_name_key, school_name, school_name_key,
                reviewer_name, rating, difficulty, attendance, year, term, instructor,
                user_id, helpful_count, report_count, text, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
            [
                review.id,
                review.courseName,
                review.courseNameKey,
                review.schoolName,
                review.schoolNameKey,
                review.reviewerName,
                review.rating,
                review.difficulty,
                review.attendance,
                review.year,
                review.term,
                review.instructor,
                review.userId,
                review.helpfulCount,
                review.reportCount,
                review.text,
                review.createdAt,
            ]
        );
        return;
    }

    const reviews = await readUserReviews();
    reviews.unshift(review);
    await writeUserReviews(sortReviews(reviews));
}

async function getUserReviewStats(courseName, schoolName) {
    if (USE_POSTGRES) {
        const pool = await getPgPool();
        const query = buildReviewFilterQuery(courseName, schoolName);
        const result = await pool.query(
            `SELECT rating, difficulty, attendance
             FROM user_reviews
             ${query.where}`,
            query.values
        );
        return calculateReviewStats(result.rows);
    }

    const reviews = await readUserReviews();
    return calculateReviewStats(filterUserReviews(reviews, courseName, schoolName, Infinity));
}

async function writeUserReviews(reviews) {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tempFile = `${USER_REVIEWS_FILE}.tmp`;
    await fs.promises.writeFile(tempFile, JSON.stringify(reviews, null, 2), 'utf8');
    await fs.promises.rename(tempFile, USER_REVIEWS_FILE);
}

function normalizeUserReview(body) {
    const courseName = String(body.courseName || '').trim();
    const schoolName = String(body.schoolName || '').trim();
    const reviewerName = String(body.reviewerName || '匿名').trim().slice(0, 40) || '匿名';
    const userId = String(body.userId || '').trim().slice(0, 80);
    const year = normalizeYear(body.year);
    const term = normalizeReviewChoice(body.term, ['春', '夏', '秋', '冬', '通年', '不明'], '不明');
    const instructor = String(body.instructor || '').trim().slice(0, 80);
    const text = String(body.text || '').trim();
    const rating = Number(body.rating);
    const difficulty = normalizeReviewChoice(body.difficulty, ['高', '中', '低', '不明'], '不明');
    const attendance = normalizeReviewChoice(body.attendance, ['高', '中', '低', '不明'], '不明');

    if (!courseName) {
        throwBadRequest('講義名を入力してください。');
    }

    if (text.length < 10) {
        throwBadRequest('口コミ本文は10文字以上で入力してください。');
    }

    if (text.length > MAX_USER_REVIEW_LENGTH) {
        throwBadRequest(`口コミ本文は${MAX_USER_REVIEW_LENGTH}文字以内で入力してください。`);
    }

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        throwBadRequest('評価は1〜5で選んでください。');
    }

    const now = new Date().toISOString();
    return {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        courseName,
        courseNameKey: normalizeReviewKey(courseName),
        schoolName,
        schoolNameKey: normalizeReviewKey(schoolName),
        reviewerName,
        rating,
        difficulty,
        attendance,
        year,
        term,
        instructor,
        userId,
        helpfulCount: 0,
        reportCount: 0,
        text,
        createdAt: now,
    };
}

function normalizeYear(value) {
    const year = Number(value);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        return '';
    }
    return String(year);
}

function filterUserReviews(reviews, courseName, schoolName, limit = 50) {
    const courseKey = normalizeReviewKey(courseName);
    const schoolKey = normalizeReviewKey(schoolName);

    return sortReviews(reviews.filter((review) => {
        const reviewCourseKey = review.courseNameKey || normalizeReviewKey(review.courseName);
        const reviewSchoolKey = review.schoolNameKey || normalizeReviewKey(review.schoolName);

        if (courseKey && reviewCourseKey !== courseKey) {
            return false;
        }

        if (schoolKey && reviewSchoolKey && reviewSchoolKey !== schoolKey) {
            return false;
        }

        return true;
    })).slice(0, limit);
}

async function assertCanSubmitReview(req, review) {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    const key = `${ip}:${review.courseNameKey}`;
    const now = Date.now();
    const recent = reviewRateLimits.get(key) || [];
    const active = recent.filter(timestamp => now - timestamp < 60 * 1000);

    if (active.length >= 3) {
        throwBadRequest('短時間に投稿しすぎています。少し待ってから投稿してください。');
    }

    active.push(now);
    reviewRateLimits.set(key, active);

    const existing = await findDuplicateReview(review);
    if (existing) {
        throwBadRequest('同じ講義に同じ内容の口コミがすでに投稿されています。');
    }
}

async function findDuplicateReview(review) {
    const textKey = normalizeReviewKey(review.text);

    if (USE_POSTGRES) {
        const pool = await getPgPool();
        const result = await pool.query(
            `SELECT id FROM user_reviews
             WHERE course_name_key = $1 AND lower(trim(text)) = $2
             LIMIT 1`,
            [review.courseNameKey, textKey]
        );
        return result.rows[0] || null;
    }

    const reviews = await readUserReviews();
    return reviews.find(item => {
        const courseKey = item.courseNameKey || normalizeReviewKey(item.courseName);
        return courseKey === review.courseNameKey && normalizeReviewKey(item.text) === textKey;
    });
}

async function markReviewHelpful(id) {
    if (USE_POSTGRES) {
        const pool = await getPgPool();
        const result = await pool.query(
            `UPDATE user_reviews
             SET helpful_count = helpful_count + 1
             WHERE id = $1
             RETURNING id, course_name, school_name, reviewer_name, rating, difficulty, attendance,
                       year, term, instructor, user_id, helpful_count, report_count, text, created_at`,
            [id]
        );
        return requireReviewRow(result.rows[0]);
    }

    return updateJsonReview(id, review => ({
        ...review,
        helpfulCount: Number(review.helpfulCount || 0) + 1,
    }));
}

async function reportUserReview(id) {
    if (USE_POSTGRES) {
        const pool = await getPgPool();
        const result = await pool.query(
            `UPDATE user_reviews
             SET report_count = report_count + 1
             WHERE id = $1
             RETURNING id, course_name, school_name, reviewer_name, rating, difficulty, attendance,
                       year, term, instructor, user_id, helpful_count, report_count, text, created_at`,
            [id]
        );
        return requireReviewRow(result.rows[0]);
    }

    return updateJsonReview(id, review => ({
        ...review,
        reportCount: Number(review.reportCount || 0) + 1,
    }));
}

async function deleteUserReview(id) {
    if (USE_POSTGRES) {
        const pool = await getPgPool();
        const result = await pool.query('DELETE FROM user_reviews WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            throwNotFound('口コミが見つかりません。');
        }
        return;
    }

    const reviews = await readUserReviews();
    const nextReviews = reviews.filter(review => review.id !== id);
    if (nextReviews.length === reviews.length) {
        throwNotFound('口コミが見つかりません。');
    }
    await writeUserReviews(nextReviews);
}

async function updateJsonReview(id, updater) {
    const reviews = await readUserReviews();
    const index = reviews.findIndex(review => review.id === id);
    if (index < 0) {
        throwNotFound('口コミが見つかりません。');
    }

    reviews[index] = normalizeStoredReview(updater(reviews[index]));
    await writeUserReviews(sortReviews(reviews));
    return reviews[index];
}

function requireReviewRow(row) {
    if (!row) {
        throwNotFound('口コミが見つかりません。');
    }
    return rowToUserReview(row);
}

function requireAdmin(req) {
    const token = req.get('x-admin-token') || '';
    if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
        const error = new Error('管理者トークンが必要です。');
        error.statusCode = 403;
        throw error;
    }
}

function throwNotFound(message) {
    const error = new Error(message);
    error.statusCode = 404;
    throw error;
}

function sortReviews(reviews) {
    return reviews.slice().sort((a, b) => {
        const helpfulDiff = Number(b.helpfulCount || 0) - Number(a.helpfulCount || 0);
        if (helpfulDiff !== 0) {
            return helpfulDiff;
        }
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });
}

function normalizeStoredReview(review) {
    return {
        ...review,
        courseNameKey: review.courseNameKey || normalizeReviewKey(review.courseName),
        schoolNameKey: review.schoolNameKey || normalizeReviewKey(review.schoolName),
        reviewerName: review.reviewerName || '匿名',
        year: review.year || '',
        term: review.term || '不明',
        instructor: review.instructor || '',
        userId: review.userId || '',
        helpfulCount: Number(review.helpfulCount || 0),
        reportCount: Number(review.reportCount || 0),
    };
}

async function listCourses(filters) {
    const summaries = USE_POSTGRES
        ? await listPostgresCourseSummaries()
        : await listJsonCourseSummaries();

    return summaries
        .filter(course => matchesCourseFilters(course, filters))
        .sort((a, b) => sortCourses(a, b, filters.sort))
        .slice(0, 30);
}

async function listRecommendedCourses(priority) {
    const filters = {
        query: '',
        schoolName: '',
        minRating: 0,
        difficulty: '',
        attendance: '',
        sort: mapPriorityToSort(priority),
    };
    const courses = await listCourses(filters);
    return courses.slice(0, 8);
}

async function listJsonCourseSummaries() {
    const reviews = (await readUserReviews()).map(normalizeStoredReview);
    return summarizeCourses(reviews);
}

async function listPostgresCourseSummaries() {
    const pool = await getPgPool();
    const result = await pool.query(
        `SELECT course_name, school_name, rating, difficulty, attendance, helpful_count, report_count, created_at
         FROM user_reviews`
    );
    return summarizeCourses(result.rows.map(row => ({
        courseName: row.course_name,
        schoolName: row.school_name,
        rating: row.rating,
        difficulty: row.difficulty,
        attendance: row.attendance,
        helpfulCount: row.helpful_count,
        reportCount: row.report_count,
        createdAt: row.created_at,
    })));
}

function summarizeCourses(reviews) {
    const groups = new Map();

    reviews.forEach((review) => {
        const courseName = String(review.courseName || '').trim();
        if (!courseName) {
            return;
        }

        const schoolName = String(review.schoolName || '').trim();
        const key = `${normalizeReviewKey(courseName)}::${normalizeReviewKey(schoolName)}`;
        const group = groups.get(key) || {
            courseName,
            schoolName,
            reviews: [],
        };
        group.reviews.push(review);
        groups.set(key, group);
    });

    return Array.from(groups.values()).map((group) => {
        const stats = calculateReviewStats(group.reviews);
        const helpfulTotal = group.reviews.reduce((sum, review) => sum + Number(review.helpfulCount || 0), 0);
        const reportTotal = group.reviews.reduce((sum, review) => sum + Number(review.reportCount || 0), 0);
        const latestAt = group.reviews.reduce((latest, review) => {
            const time = new Date(review.createdAt || 0).getTime();
            return Math.max(latest, Number.isFinite(time) ? time : 0);
        }, 0);

        return {
            courseName: group.courseName,
            schoolName: group.schoolName,
            stats,
            helpfulTotal,
            reportTotal,
            latestAt: latestAt ? new Date(latestAt).toISOString() : '',
        };
    });
}

function normalizeCourseFilters(query) {
    return {
        query: String(query.q || '').trim(),
        schoolName: String(query.schoolName || '').trim(),
        minRating: clampServerNumber(query.minRating, 0, 5, 0),
        difficulty: String(query.difficulty || '').trim(),
        attendance: String(query.attendance || '').trim(),
        sort: String(query.sort || 'rating').trim(),
    };
}

function matchesCourseFilters(course, filters) {
    const haystack = normalizeReviewKey(`${course.courseName} ${course.schoolName}`);
    if (filters.query && !haystack.includes(normalizeReviewKey(filters.query))) {
        return false;
    }

    if (filters.schoolName && !normalizeReviewKey(course.schoolName).includes(normalizeReviewKey(filters.schoolName))) {
        return false;
    }

    if (filters.minRating && course.stats.averageRating < filters.minRating) {
        return false;
    }

    if (filters.difficulty && filters.difficulty !== '指定なし' && course.stats.difficultyTrend !== filters.difficulty) {
        return false;
    }

    if (filters.attendance && filters.attendance !== '指定なし' && course.stats.attendanceTrend !== filters.attendance) {
        return false;
    }

    return true;
}

function sortCourses(a, b, sort) {
    if (sort === 'easy') {
        return difficultyWeight(a.stats.difficultyTrend) - difficultyWeight(b.stats.difficultyTrend)
            || attendanceWeight(a.stats.attendanceTrend) - attendanceWeight(b.stats.attendanceTrend)
            || b.stats.averageRating - a.stats.averageRating;
    }

    if (sort === 'popular') {
        return b.stats.count - a.stats.count || b.helpfulTotal - a.helpfulTotal;
    }

    if (sort === 'recent') {
        return new Date(b.latestAt || 0).getTime() - new Date(a.latestAt || 0).getTime();
    }

    return b.stats.averageRating - a.stats.averageRating || b.stats.count - a.stats.count;
}

function mapPriorityToSort(priority) {
    if (priority.includes('ラク') || priority.includes('落単')) {
        return 'easy';
    }
    if (priority.includes('高評価') || priority.includes('面白')) {
        return 'rating';
    }
    return 'popular';
}

function difficultyWeight(value) {
    return { 低: 1, 中: 2, 不明: 3, 高: 4 }[value] || 3;
}

function attendanceWeight(value) {
    return { 低: 1, 中: 2, 不明: 3, 高: 4 }[value] || 3;
}

function clampServerNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, number));
}

async function getCachedAnalysis(cacheKey) {
    if (USE_POSTGRES) {
        const pool = await getPgPool();
        const result = await pool.query('SELECT result_json FROM analysis_cache WHERE cache_key = $1', [cacheKey]);
        return result.rows[0]?.result_json || null;
    }

    const cache = await readAnalysisCache();
    return cache[cacheKey]?.result || null;
}

async function saveCachedAnalysis(cacheKey, result) {
    if (USE_POSTGRES) {
        const pool = await getPgPool();
        await pool.query(
            `INSERT INTO analysis_cache (cache_key, result_json, created_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (cache_key)
             DO UPDATE SET result_json = EXCLUDED.result_json, created_at = NOW()`,
            [cacheKey, JSON.stringify(result)]
        );
        return;
    }

    const cache = await readAnalysisCache();
    cache[cacheKey] = {
        result,
        createdAt: new Date().toISOString(),
    };
    await writeAnalysisCache(cache);
}

async function readAnalysisCache() {
    try {
        const content = await fs.promises.readFile(ANALYSIS_CACHE_FILE, 'utf8');
        const parsed = JSON.parse(content);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {};
        }
        throw error;
    }
}

async function writeAnalysisCache(cache) {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tempFile = `${ANALYSIS_CACHE_FILE}.tmp`;
    await fs.promises.writeFile(tempFile, JSON.stringify(cache, null, 2), 'utf8');
    await fs.promises.rename(tempFile, ANALYSIS_CACHE_FILE);
}

function hashValue(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

async function getPgPool() {
    if (!pgPool) {
        let Pool;
        try {
            ({ Pool } = require('pg'));
        } catch (error) {
            throw new Error('DATABASE_URL is set, but the pg package is not installed. Run npm install pg and restart the app.');
        }

        pgPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
        });
    }

    if (!pgReadyPromise) {
        pgReadyPromise = ensurePgSchema(pgPool);
    }

    await pgReadyPromise;
    return pgPool;
}

async function ensurePgSchema(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_reviews (
            id TEXT PRIMARY KEY,
            course_name TEXT NOT NULL,
            course_name_key TEXT NOT NULL,
            school_name TEXT NOT NULL DEFAULT '',
            school_name_key TEXT NOT NULL DEFAULT '',
            reviewer_name TEXT NOT NULL DEFAULT '匿名',
            rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
            difficulty TEXT NOT NULL DEFAULT '不明',
            attendance TEXT NOT NULL DEFAULT '不明',
            year TEXT NOT NULL DEFAULT '',
            term TEXT NOT NULL DEFAULT '不明',
            instructor TEXT NOT NULL DEFAULT '',
            user_id TEXT NOT NULL DEFAULT '',
            helpful_count INTEGER NOT NULL DEFAULT 0,
            report_count INTEGER NOT NULL DEFAULT 0,
            text TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query("ALTER TABLE user_reviews ADD COLUMN IF NOT EXISTS year TEXT NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE user_reviews ADD COLUMN IF NOT EXISTS term TEXT NOT NULL DEFAULT '不明'");
    await pool.query("ALTER TABLE user_reviews ADD COLUMN IF NOT EXISTS instructor TEXT NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE user_reviews ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT ''");
    await pool.query('ALTER TABLE user_reviews ADD COLUMN IF NOT EXISTS helpful_count INTEGER NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE user_reviews ADD COLUMN IF NOT EXISTS report_count INTEGER NOT NULL DEFAULT 0');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS analysis_cache (
            cache_key TEXT PRIMARY KEY,
            result_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_user_reviews_course ON user_reviews (course_name_key, created_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_user_reviews_school ON user_reviews (school_name_key)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_user_reviews_helpful ON user_reviews (helpful_count DESC)');
}

function buildReviewFilterQuery(courseName, schoolName) {
    const values = [];
    const conditions = [];
    const courseKey = normalizeReviewKey(courseName);
    const schoolKey = normalizeReviewKey(schoolName);

    if (courseKey) {
        values.push(courseKey);
        conditions.push(`course_name_key = $${values.length}`);
    }

    if (schoolKey) {
        values.push(schoolKey);
        conditions.push(`(school_name_key = '' OR school_name_key = $${values.length})`);
    }

    return {
        where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
        values,
    };
}

function rowToUserReview(row) {
    return {
        id: row.id,
        courseName: row.course_name,
        schoolName: row.school_name,
        reviewerName: row.reviewer_name,
        rating: Number(row.rating),
        difficulty: row.difficulty,
        attendance: row.attendance,
        year: row.year || '',
        term: row.term || '不明',
        instructor: row.instructor || '',
        userId: row.user_id || '',
        helpfulCount: Number(row.helpful_count || 0),
        reportCount: Number(row.report_count || 0),
        text: row.text,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
}

function calculateReviewStats(reviews) {
    const count = reviews.length;
    const ratingTotal = reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0);
    const difficultyCounts = countChoices(reviews, 'difficulty');
    const attendanceCounts = countChoices(reviews, 'attendance');

    return {
        count,
        averageRating: count ? Math.round((ratingTotal / count) * 10) / 10 : 0,
        averageRatingPercent: count ? Math.round((ratingTotal / count) / 5 * 100) : 0,
        difficultyTrend: mostCommonChoice(difficultyCounts),
        attendanceTrend: mostCommonChoice(attendanceCounts),
        difficultyCounts,
        attendanceCounts,
    };
}

function countChoices(reviews, key) {
    return reviews.reduce((counts, review) => {
        const value = review[key] || '不明';
        counts[value] = (counts[value] || 0) + 1;
        return counts;
    }, {});
}

function mostCommonChoice(counts) {
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '不明';
}

function normalizeReviewChoice(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function normalizeReviewKey(value) {
    return String(value || '').trim().toLowerCase();
}

function throwBadRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Config: ${PROVIDER} - ${MODEL}`);
});
