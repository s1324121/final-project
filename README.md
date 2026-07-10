# 先輩風・講義レビュー

講義名、シラバス、口コミからLLMで講義レビューを要約するアプリです。

## 口コミ保存

利用者が投稿した口コミは、標準では `data/reviews.json` に保存されます。

追加済みの機能:

- 講義検索・絞り込み
- 講義ごとの平均評価・難易度傾向・出席傾向
- 講義比較
- 条件に応じたおすすめ講義
- 年度・学期・担当教員つき口コミ
- 簡易ログイン名の保存
- 役に立った投票
- 通報
- 管理者トークンによる口コミ削除
- 同一本文の重複投稿防止
- 短時間の連投制限
- AI分析結果のキャッシュ

PostgreSQLに保存したい場合は、`pg` を追加して `.env.local` に `DATABASE_URL` を設定してください。

```bash
npm install pg
```

```env
DATABASE_URL=postgres://user:password@host:5432/database
```

`DATABASE_URL` がある場合、起動時に `user_reviews` テーブルと検索用インデックスを自動作成します。

口コミ削除を有効にするには `.env.local` に `ADMIN_TOKEN` を設定してください。

```env
ADMIN_TOKEN=change-this-admin-token
```
