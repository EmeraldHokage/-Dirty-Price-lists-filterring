# -Dirty-Price-lists-filterring

Web app for uploading a dirty CSV price list, cleaning it locally and with OpenAI API, and downloading the cleaned CSV.

## Setup

1. Create a local `.env` file and set:
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL` (optional, defaults to `gpt-5.4-mini`)
   - `OPENAI_TIMEOUT_MS` (optional, defaults to `60000`)
   - `OPENAI_MAX_RETRIES` (optional, defaults to `2`)
2. Start the app:

```bash
npm start
```

3. Open `http://localhost:3000`

## Notes

- The server accepts CSV content as JSON, not multipart form data.
- If `OPENAI_API_KEY` is missing, the app still performs local CSV cleanup only.
