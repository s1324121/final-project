const express = require('express');
const fs = require('fs');
const path = require('path');
// API Key などの環境変数は .env.local から読み込む
require('dotenv').config({ path: '.env.local' });

const app = express();
const PORT = process.env.PORT || 8080;

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

        let result;
        if (PROVIDER === 'openai') {
            result = await callOpenAI(finalPrompt);
        } else if (PROVIDER === 'gemini') {
            result = await callGemini(finalPrompt);
        } else {
            return res.status(400).json({ error: 'Invalid provider configuration' });
        }

        res.json({
            title: title,
            data: result,
            rawData: JSON.stringify(result),
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

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Config: ${PROVIDER} - ${MODEL}`);
});
