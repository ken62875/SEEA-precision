/**
 * SEEA Precision — 로컬 개발 서버
 * 실행: node server.mjs
 * 의존성: 없음 (Node.js 18+ 내장 모듈만 사용)
 */

import http   from 'http';
import fs     from 'fs';
import path   from 'path';
import { fileURLToPath } from 'url';
import { searchBib, getCompInfo, getGamePageHtml } from './bib-scraper.mjs';
import { startWatcher } from './watcher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = 3000;

// 대회별 전체 선수 캐시 (메모리, 2시간 유지)
const compPlayersCache = new Map(); // compCode → { players: [], ts: number }

// ── .env 파일 로드 ────────────────────────────────────────
function loadEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx < 1) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && !process.env[key]) process.env[key] = val;
    }
  } catch { /* .env 없어도 무시 */ }
}
loadEnv();

// ── ISSF 규정 AI 시스템 프롬프트 ─────────────────────────
const SYSTEM_PROMPT = `당신은 SEEA Precision AI입니다. 한국 사격 선수, 코치, 심판을 위한 ISSF(국제사격연맹) 규정 전문 어시스턴트입니다.

[역할과 답변 규칙]
1. 항상 한국어로 답변하세요.
2. 첨부된 ISSF 공식 규정집 PDF를 최우선으로 참조하여 정확하게 답변하세요.
3. 규정 조항 번호를 반드시 인용하세요 (예: "ISSF TR 6.4.1.2", "ISSF GTR 3.1.5").
4. 규정집에서 찾을 수 없는 내용은 "규정집에서 확인되지 않습니다. 원문을 직접 확인하세요"라고 명시하세요.
5. 모든 답변 마지막에 반드시 다음 면책 문구를 추가하세요:
   "⚠️ 이 답변은 참고용입니다. 공식 판정의 근거가 될 수 없으며, 최신 ISSF 원문 규정을 반드시 확인하세요."
6. 지원 종목: 10m 공기소총, 10m 공기권총, 50m 소총 3자세, 50m 소총 복사, 25m 권총, 25m 스포츠 권총, 트랩(Trap), 더블 트랩(Double Trap), 스키트(Skeet).
7. ISSF 규정 외 질문(사격 기술, 훈련법, 장비 구매 등)은 "이 서비스는 ISSF 규정 안내에 특화되어 있습니다. 규정 관련 질문을 해주세요."라고 안내하세요.
8. 답변은 간결하고 명확하게, 선수가 경기장에서 빠르게 확인할 수 있도록 작성하세요.

[종목 범위 확인 규칙 — 반드시 준수]
9. 질문이 특정 종목을 명시하지 않고 광범위한 경우(예: "소총 규정", "권총 규정", "복장 규정", "장비 규정" 등) 절대로 모든 종목을 한꺼번에 나열하지 마세요.
   대신 아래 형식으로 반드시 종목을 먼저 확인하세요:

   소총 관련 질문 시:
   "어떤 종목의 규정이 궁금하신가요?
   1️⃣ 10m 공기소총
   2️⃣ 50m 소총 3자세
   3️⃣ 50m 소총 복사"

   권총 관련 질문 시:
   "어떤 종목의 규정이 궁금하신가요?
   1️⃣ 10m 공기권총
   2️⃣ 25m 권총
   3️⃣ 25m 스포츠 권총"

   클레이(산탄총) 관련 질문 시:
   "어떤 종목의 규정이 궁금하신가요?
   1️⃣ 트랩(Trap)
   2️⃣ 더블 트랩(Double Trap)
   3️⃣ 스키트(Skeet)"

   종목 구분 없이 전체적인 질문(복장, 장비, 표적 등) 시:
   "어떤 종목의 규정이 궁금하신가요?
   1️⃣ 10m 공기소총  2️⃣ 10m 공기권총
   3️⃣ 50m 소총 3자세  4️⃣ 50m 소총 복사
   5️⃣ 25m 권총  6️⃣ 25m 스포츠 권총
   7️⃣ 트랩  8️⃣ 더블 트랩  9️⃣ 스키트"

10. 사용자가 번호 또는 종목명으로 답하면 그때 해당 종목의 규정만 정확하게 답변하세요.
11. 아래 종목명 키워드가 질문에 포함되어 있으면 종목 확인 없이 반드시 바로 답변하세요:
    - "공기소총", "AR", "10m 소총" → 10m 공기소총
    - "공기권총", "AP", "10m 권총" → 10m 공기권총
    - "3자세", "3P", "50m 3자세", "소총 3자세" → 50m 소총 3자세
    - "복사", "PR", "50m 복사", "소총 복사" → 50m 소총 복사
    - "25m 권총", "RF", "래피드파이어" → 25m 권총
    - "스포츠 권총", "SP", "25m 스포츠" → 25m 스포츠 권총
    - "트랩", "Trap" → 트랩
    - "더블 트랩", "Double Trap" → 더블 트랩
    - "스키트", "Skeet" → 스키트
    질문에 위 키워드가 하나라도 있으면 종목이 특정된 것으로 간주하고 즉시 답변하세요.

[답변 스타일 규칙]
12. 답변은 핵심을 먼저 전달하되, 단순히 "허용/금지" 한 줄로 끝내지 말고 **왜 그런지, 어떤 상황에서 적용되는지, 어떻게 측정/판정하는지** 등 실용적인 맥락을 포함해 3~6문장으로 작성하세요. "헷갈리기 쉬운 인접 규정"을 별도 항목으로 나누지 말고 답변 본문 안에 자연스럽게 녹여서 설명하세요.
13. 규정 조항을 인용할 때는 반드시 해당 조항의 실제 내용과 일치하는지 확인하세요. PDF에서 직접 확인되지 않은 내용을 조항 번호와 함께 단정적으로 서술하지 마세요. 불확실한 경우 "규정집에서 직접 확인을 권장합니다"라고 명시하세요.
14. 규정이 명확하지 않거나 심판 재량이 개입되는 회색 지대는 "이 부분은 심판 재량에 따를 수 있습니다" 또는 "상황에 따라 다를 수 있습니다"라고 솔직하게 안내하세요.
15. 딱딱한 법조문 스타일 대신 선수가 경기장에서 바로 이해할 수 있는 실용적인 언어로 풀어서 설명하세요.
16. 사용자가 "더 자세히", "구체적으로", "예시를 들어" 등을 요청할 때만 더 상세한 내용을 추가 설명하세요.

[한국 사격계 용어 규칙 — 반드시 준수]
16. 한국 사격계에서는 ISSF의 "Qualification(예선)" 경기를 관행적으로 **"본선"**이라고 부릅니다.
    따라서 사용자가 "본선"이라고 질문하면 이는 ISSF 규정집의 "Qualification" 경기를 의미하는 것으로 이해하고 답변하세요.
    이때 반드시 다음 내용을 짧게 덧붙이세요:
    "※ 참고로 한국에서 '본선'이라고 부르는 경기는 ISSF 공식 용어로 'Qualification(예선)'입니다. ISSF에서 '결선(Final)'은 상위 선수들이 진출하는 별도 경기입니다."
17. "결선"은 ISSF의 "Final"에 해당합니다. 사용자가 "결선"이라고 하면 Final 규정으로 답변하세요.
18. "예선"이라는 단어는 한국 사격계에서 거의 사용되지 않으므로, 답변에서 직접 "예선"이라고 표현하지 말고 "본선(Qualification)"으로 표기하세요.

[자주 혼동되는 규정 — 반드시 이 내용을 우선 적용]
19. 10m 공기소총 / 50m 소총 복사 본선(Qualification) 동점 처리:
    - 이 종목들은 소수점 채점이므로 동점 처리 기준은 ISSF GTR 6.15.1 f 적용
    - 순서: ① 마지막 10발 시리즈 소수점 점수 비교 → ② 마지막 발부터 한 발씩 소수점 점수 비교
    - ❌ 이너 텐(X-ten / Inner Ten) 개수는 이 종목 동점 처리의 기준이 아님
    - 이너 텐 비교(GTR 6.15.1 a)는 정수 채점 종목(10m 공기권총 등)에만 적용됨
    - 예) 627.8점 동점에서 X-ten 50개 선수 vs 마지막 시리즈 높은 선수 → 마지막 시리즈 높은 선수가 상위 순위

20. 10m 공기권총 / 25m 권총 / 25m 스포츠 권총 본선(Qualification) 동점 처리:
    - 이 종목들은 정수 채점이므로 ISSF GTR 6.15.1 a~e 순서 적용
    - 순서: ① 이너 텐(X-ten) 개수 → ② 마지막 시리즈부터 역순 정수 점수 비교 → ③ 마지막 발부터 이너 텐 비교 → ④ EST 사용 시 소수점 비교 → ⑤ 공동 순위(알파벳순)`;

// ── PDF 규정집 업로드 (Gemini Files API) ──────────────────
let rulesFileUri   = null;
let rulesUploading = false;

async function uploadRulesPDF() {
  if (!process.env.GEMINI_API_KEY) return;

  const rulesDir = path.join(__dirname, 'rules');
  let pdfPath = null;
  try {
    const files = fs.readdirSync(rulesDir);
    const pdf   = files.find(f => f.toLowerCase().endsWith('.pdf'));
    if (pdf) pdfPath = path.join(rulesDir, pdf);
  } catch { /* 폴더 없으면 무시 */ }

  if (!pdfPath) {
    console.log('    📄 규정집 없음 — rules/ 폴더에 PDF를 넣으면 자동 학습됩니다');
    return;
  }

  rulesUploading = true;
  const fileName = path.basename(pdfPath);
  const fileSize = fs.statSync(pdfPath).size;
  const sizeMB   = (fileSize / 1024 / 1024).toFixed(1);
  console.log(`    📤 규정집 업로드 중: ${fileName} (${sizeMB} MB) ...`);

  try {
    const pdfData = fs.readFileSync(pdfPath);

    if (fileSize < 15 * 1024 * 1024) {
      // ── 15 MB 미만: multipart upload ──────────────────
      const boundary = 'GeminiBoundary' + Date.now();
      const metadata = JSON.stringify({ file: { display_name: 'ISSF Rules 2026' } });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
        Buffer.from(metadata),
        Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
        pdfData,
        Buffer.from(`\r\n--${boundary}--`),
      ]);

      const res = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${process.env.GEMINI_API_KEY}`,
        {
          method:  'POST',
          headers: {
            'Content-Type':           `multipart/related; boundary=${boundary}`,
            'X-Goog-Upload-Protocol': 'multipart',
          },
          body,
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `Upload HTTP ${res.status}`);
      }
      const data = await res.json();
      rulesFileUri = data.file?.uri;

    } else {
      // ── 15 MB 이상: resumable upload ──────────────────
      // Step 1: 업로드 세션 초기화
      const initRes = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${process.env.GEMINI_API_KEY}`,
        {
          method:  'POST',
          headers: {
            'Content-Type':                        'application/json',
            'X-Goog-Upload-Protocol':              'resumable',
            'X-Goog-Upload-Command':               'start',
            'X-Goog-Upload-Header-Content-Length': String(fileSize),
            'X-Goog-Upload-Header-Content-Type':   'application/pdf',
          },
          body: JSON.stringify({ file: { display_name: 'ISSF Rules 2026' } }),
        }
      );
      if (!initRes.ok) {
        const err = await initRes.json().catch(() => ({}));
        throw new Error(err.error?.message || `Init HTTP ${initRes.status}`);
      }
      const uploadUrl = initRes.headers.get('x-goog-upload-url');
      if (!uploadUrl) throw new Error('업로드 URL을 받지 못했습니다');

      // Step 2: 파일 본문 전송
      const uploadRes = await fetch(uploadUrl, {
        method:  'POST',
        headers: {
          'Content-Length':        String(fileSize),
          'X-Goog-Upload-Offset':  '0',
          'X-Goog-Upload-Command': 'upload, finalize',
        },
        body: pdfData,
      });
      if (!uploadRes.ok) {
        const err = await uploadRes.json().catch(() => ({}));
        throw new Error(err.error?.message || `Upload HTTP ${uploadRes.status}`);
      }
      const data = await uploadRes.json();
      rulesFileUri = data.file?.uri;
    }

    if (!rulesFileUri) throw new Error('URI를 받지 못했습니다');
    console.log(`    ✅ 규정집 업로드 완료 (${sizeMB} MB) — AI가 2026 전체 규정집으로 답변합니다`);
  } catch (e) {
    console.log(`    ❌ 규정집 업로드 실패: ${e.message}`);
  } finally {
    rulesUploading = false;
  }
}

// ── MIME 타입 ─────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.ttf':  'font/ttf',
};

// ── HTTP 서버 ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── POST /api/chat ──────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/chat') {
    if (!process.env.GEMINI_API_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API key not configured' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { messages } = JSON.parse(body);
        if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages 필드가 비어 있습니다.');

        // PDF 규정집이 업로드된 경우 첫 번째 컨텍스트로 삽입
        const geminiMessages = [];

        if (rulesFileUri) {
          geminiMessages.push({
            role: 'user',
            parts: [
              { fileData: { mimeType: 'application/pdf', fileUri: rulesFileUri } },
              { text: '이 PDF는 2026년 1월 1일 기준 ISSF 공식 규정집입니다. 이 문서를 기반으로 정확하게 답변해주세요.' },
            ],
          });
          geminiMessages.push({
            role: 'model',
            parts: [{ text: '네, 2026년 1월 1일 기준 ISSF 공식 규정집을 확인했습니다. 이 문서를 기반으로 규정 관련 질문에 정확하게 답변하겠습니다.' }],
          });
        }

        for (const m of messages) {
          geminiMessages.push({
            role:  m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          });
        }

        const apiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
              contents: geminiMessages,
              generationConfig: { maxOutputTokens: 8192, temperature: 0.3 },
            }),
          }
        );

        if (!apiRes.ok) {
          const err = await apiRes.json().catch(() => ({}));
          throw new Error(err.error?.message || `Gemini API ${apiRes.status}`);
        }

        const data    = await apiRes.json();
        const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '답변을 생성하지 못했습니다.';

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content, hasRules: !!rulesFileUri }));

      } catch (err) {
        console.error('[/api/chat]', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── GET /api/bib-debug?comp=N01H&sex=2&bb=5&i1=11 ──────
  // 인코딩·구조 진단용: td 목록 + 파싱 시뮬레이션 결과 반환
  if (req.method === 'GET' && req.url.startsWith('/api/bib-debug')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp') || 'N01H').trim();
    const sex    = params.get('sex')  || '2';
    const bb     = params.get('bb')   || '5';
    const i1     = params.get('i1')   || '11';

    try {
      const targetUrl = `https://www.shooting.or.kr/score/score_2015_player.asp?jname=${comp}&sex=${sex}&bb=${bb}&i1=${i1}`;
      const r   = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
          'Referer':    'https://www.shooting.or.kr',
          'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9',
        }
      });
      const buf = await r.arrayBuffer();
      const ct  = r.headers.get('content-type') || '';

      // EUC-KR 디코딩
      let html = '';
      try { html = new TextDecoder('euc-kr', { fatal: false }).decode(buf); }
      catch { html = new TextDecoder('utf-8', { fatal: false }).decode(buf); }

      // td 내용 전체 추출
      const stripTags = s => (s||'').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
      const allTds = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => stripTags(m[1]));
      const BIB_RE = /^\d{1,3}\s*[-–]\s*\d{1,4}$/; // "2-72" or "2 - 72"
      const bibTds = allTds.filter(t => BIB_RE.test(t));

      // 처음 60개 td와 전체 HTML 앞부분
      const lines = [
        `── 진단 URL ─────────────────────────────────────`,
        `URL: ${targetUrl}`,
        `Content-Type 헤더: ${ct}`,
        `버퍼 크기: ${buf.byteLength} bytes`,
        ``,
        `── TD 통계 ──────────────────────────────────────`,
        `전체 <td> 수: ${allTds.length}`,
        `사대번호 패턴 셀 수: ${bibTds.length}`,
        bibTds.length > 0 ? `사대번호 샘플: ${bibTds.slice(0,10).join(', ')}` : '→ 사대번호 셀 없음 (배정표 미게시 or 구조 다름)',
        ``,
        `── 첫 100개 TD 내용 ─────────────────────────────`,
        ...allTds.slice(0, 100).map((t, i) => `[${i}] ${t || '(empty)'}`),
        ``,
        `── HTML 앞 2000자 (EUC-KR 디코딩) ───────────────`,
        html.slice(0, 2000),
      ];

      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(lines.join('\n'));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('오류: ' + e.message + '\n' + e.stack);
    }
    return;
  }

  // ── GET /api/game-debug?comp=N01H ───────────────────────
  // 게임 페이지 원본 HTML + 파싱된 이벤트 목록 확인
  if (req.method === 'GET' && req.url.startsWith('/api/game-debug')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp') || 'N01H').trim();
    try {
      const { html, events } = await getGamePageHtml(comp);
      // 전체 HTML에서 날짜 패턴 검색
      const allDates = [...html.matchAll(
        /(\d{4}년?\s*\d{1,2}월\s*\d{1,2}일)|(\d{4}[.\-]\d{1,2}[.\-]\d{1,2})|(\d{1,2}월\s*\d{1,2}일)/g
      )].map(m => m[0].replace(/\s+/g,''));
      const uniqueDates = [...new Set(allDates)];

      // 전체 HTML에서 시간 패턴 검색
      const allTimes = [...html.matchAll(/\b(\d{1,2}:\d{2})\b/g)].map(m => m[1]);
      const uniqueTimes = [...new Set(allTimes)];

      // 위치 정보 포함 날짜 수집
      const DATE_FULL = /(\d{4}년?\s*\d{1,2}월\s*\d{1,2}일)|(\d{4}[.\-]\d{1,2}[.\-]\d{1,2})|(\d{1,2}월\s*\d{1,2}일)/g;
      const datePositions = [...html.matchAll(DATE_FULL)].map(m => ({ pos: m.index, text: m[0] }));
      // 위치 정보 포함 URL 수집
      const URL_FULL = /["']([^"']*score_2015_player\.asp\?[^"']+)["']/g;
      const urlPositions = [...html.matchAll(URL_FULL)].map(m => ({ pos: m.index, url: m[1] }));

      const firstUrlPos = urlPositions[0]?.pos ?? -1;
      const lastUrlPos  = urlPositions[urlPositions.length - 1]?.pos ?? -1;

      const lines = [
        `── 게임 페이지 파싱 결과 ───────────────────────────`,
        `URL: https://www.shooting.or.kr/score/score_2015_game.asp?jname=${comp}`,
        `이벤트 수: ${events.length}`,
        `HTML 총 길이: ${html.length}자`,
        ``,
        `── 날짜/시간 패턴 (전체 HTML) ───────────────────────`,
        `날짜 발견: ${uniqueDates.length}개 → ${uniqueDates.join(', ') || '없음'}`,
        `시간 발견: ${uniqueTimes.length}개 → ${uniqueTimes.join(', ') || '없음'}`,
        ``,
        `── 위치 분석 (날짜 vs URL) ──────────────────────────`,
        `첫 번째 URL 위치: ${firstUrlPos}`,
        `마지막 URL 위치: ${lastUrlPos}`,
        `날짜 위치들:`,
        ...datePositions.map(d => `  pos=${d.pos} (URL 대비 ${d.pos - firstUrlPos > 0 ? '+' : ''}${d.pos - firstUrlPos}) → ${d.text}`),
        ``,
        `── 이벤트 목록 ──────────────────────────────────────`,
        ...events.map((e, i) => {
          const sched = [e.scheduleDate, e.scheduleTime].filter(Boolean).join(' ');
          return `[${i}] ${e.eventLabel}` + (sched ? ` | ${sched}` : '') + `\n     → ${e.playerUrl}`;
        }),
        ``,
        `── 게임 페이지 HTML 앞 3000자 ───────────────────────`,
        html.slice(0, 3000),
      ];
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(lines.join('\n'));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('오류: ' + e.message);
    }
    return;
  }

  // ── GET /api/bib?comp=N01H&name=홍길동 ──────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/bib') &&
      !req.url.startsWith('/api/bib-debug') && !req.url.startsWith('/api/bib-adjacent')) {
    const params   = new URL(req.url, 'http://localhost').searchParams;
    const comp       = (params.get('comp') || '').trim();
    const name       = (params.get('name') || '').trim();
    const searchMode = (params.get('mode') || 'name').trim();

    if (!comp || !name) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'comp(대회코드)와 name(이름)이 필요합니다.' }));
      return;
    }

    try {
      const result = await searchBib(comp, name, searchMode);
      // allPlayers 캐시 (2시간 유지)
      if (result.ok && result.allPlayers?.length) {
        compPlayersCache.set(comp, { players: result.allPlayers, ts: Date.now() });
      }
      const { allPlayers: _, ...clientResult } = result; // allPlayers 제외하고 클라이언트에 전송
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(clientResult));
    } catch (err) {
      console.error('[/api/bib]', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /api/teams?comp=N01H ─────────────────────────────
  // 해당 대회에 출전한 팀 목록 반환 (캐시 우선)
  if (req.method === 'GET' && req.url.startsWith('/api/teams')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp') || '').trim();
    if (!comp) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'comp 파라미터가 필요합니다.' }));
      return;
    }
    const cached = compPlayersCache.get(comp);
    if (cached && Date.now() - cached.ts < 2 * 60 * 60 * 1000) {
      const teams = [...new Set(cached.players.map(p => p.affiliation).filter(Boolean))];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ teams }));
    } else {
      // 캐시 없으면 백그라운드에서 전체 선수 fetch 시작
      searchBib(comp, '', 'name').then(result => {
        if (result.ok && result.allPlayers?.length) {
          compPlayersCache.set(comp, { players: result.allPlayers, ts: Date.now() });
        }
      }).catch(() => {});
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ teams: [], warming: true }));
    }
    return;
  }

  // ── GET /api/bib-adjacent?comp=N01H&event=…&group=2&lane=76 ──
  if (req.method === 'GET' && req.url.startsWith('/api/bib-adjacent')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp')  || '').trim();
    const event  = (params.get('event') || '').trim();
    const group  = (params.get('group') || '').trim();
    const lane   = parseInt(params.get('lane') || '0', 10);
    if (!comp || !event || !group || !lane) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '파라미터가 부족합니다.' }));
      return;
    }
    try {
      let players;
      const cached = compPlayersCache.get(comp);
      if (cached && Date.now() - cached.ts < 2 * 60 * 60 * 1000) {
        players = cached.players;
      } else {
        const result = await searchBib(comp, '', 'name'); // 전체 가져오기
        if (!result.ok) throw new Error(result.error || '데이터 없음');
        compPlayersCache.set(comp, { players: result.allPlayers, ts: Date.now() });
        players = result.allPlayers;
      }
      const groupPlayers = players
        .filter(p => p.event === event && p.group === group)
        .sort((a, b) => parseInt(a.lane) - parseInt(b.lane));
      const idx  = groupPlayers.findIndex(p => parseInt(p.lane) === lane);
      const prev = idx > 0 ? groupPlayers[idx - 1] : null;
      const next = idx !== -1 && idx < groupPlayers.length - 1 ? groupPlayers[idx + 1] : null;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ prev, next }));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /api/comp-info?comp=N01H ────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/comp-info')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp') || '').trim();
    if (!comp) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'comp 파라미터가 필요합니다.' }));
      return;
    }
    try {
      const info = await getCompInfo(comp);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(info));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── 정적 파일 서빙 ──────────────────────────────────────
  let urlPath = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const fullPath = path.join(__dirname, urlPath);

  if (!fullPath.startsWith(__dirname + path.sep) && fullPath !== __dirname) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (err2, idx) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(idx);
      });
      return;
    }
    const ext         = path.extname(fullPath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  const hasKey = !!process.env.GEMINI_API_KEY;
  console.log('\n🎯  SEEA Precision 서버 시작');
  console.log(`    URL : http://localhost:${PORT}`);
  console.log(`    API : ${hasKey ? '✅  연결됨 (gemini-2.5-flash)' : '⚠️   GEMINI_API_KEY 없음 → UI 전용 모드'}`);
  if (!hasKey) console.log('    →  .env 파일에 GEMINI_API_KEY=AIza... 를 추가하세요');
  console.log('\n    브라우저에서 http://localhost:3000 을 열어주세요\n');

  // 서버 시작 후 PDF 업로드 (비동기 — 서버 구동을 막지 않음)
  if (hasKey) {
    uploadRulesPDF();
    // 48시간 만료 전에 24시간마다 재업로드
    setInterval(() => {
      console.log('    🔄 규정집 24시간 자동 재업로드 중...');
      rulesFileUri = null;
      uploadRulesPDF();
    }, 24 * 60 * 60 * 1000);
  }

  // KSF 대회 목록 감시 시작
  startWatcher();
});
