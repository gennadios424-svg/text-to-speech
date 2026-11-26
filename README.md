# VoiceForge 50+

A browser-based dialogue voice studio. It loads distinct male English voices from the ElevenLabs shared voice library, assigns a different voice to each dialogue line, generates the clips, and joins them into one MP3.

## Requirements
- Node.js 20+
- An ElevenLabs API key with access to the voice library and text-to-speech API
- FFmpeg (bundled through `ffmpeg-static`)

## Run locally
1. Copy `.env.example` to `.env`.
2. Add your API key to `ELEVENLABS_API_KEY`.
3. Run `npm install`, then `npm start`.
4. Open http://localhost:3000.

An adult account holder should manage the external voice-service account and API key where the provider's age rules require it. Never commit your real API key to GitHub.

## How it works
- Searches the shared voice library for English male voices.
- Shows up to 50 distinct voice profiles and their available preview links.
- Uses one distinct voice per line (up to 50 lines).
- Generates MP3 clips sequentially and merges them into one downloadable MP3.
- The API key stays on the server; it is never sent to the browser.

Voice availability, quality, access, and usage costs depend on the provider account and its current plan. The app does not guarantee that 50 usable voices are available to every account.

## Notes
The source dialogue is editable in the app. The final combined MP3 is generated on demand and is not committed to the repository.
