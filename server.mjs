/**
 * SEEA Precision — 로컬 개발 서버
 * 실행: node server.mjs
 * 의존성: 없음 (Node.js 18+ 내장 모듈만 사용)
 */

import http   from 'http';
import fs     from 'fs';
import path   from 'path';
import { fileURLToPath } from 'url';
import { searchBib, getCompInfo, getGamePageHtml, getCompList, getEventRankings } from './bib-scraper.mjs';
import { startWatcher } from './watcher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = 3000;

// 대회별 전체 선수 캐시 (메모리, 2시간 유지)
const compPlayersCache = new Map(); // compCode → { players: [], ts: number }
// 대회 목록 캐시 (30분)
let compListCache = null; // { data: [], ts: number }
// 순위 캐시 (5분)
const rankingsCache = new Map(); // url → { data, ts }

// ── 동명이인 생년 DB 로드 ─────────────────────────────────
function loadPlayerBirths() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'player-births.json'), 'utf8');
    const data = JSON.parse(raw);
    const map = new Map();
    for (const [key, val] of Object.entries(data)) {
      if (key.startsWith('_')) continue;
      map.set(key, Array.isArray(val) ? val : [val]);
    }
    return map;
  } catch { return new Map(); }
}
let playerBirthsDB = loadPlayerBirths();
// 파일 변경 감지 (서버 재시작 없이 반영)
fs.watch(path.join(__dirname, 'player-births.json'), () => {
  playerBirthsDB = loadPlayerBirths();
  console.log('[births] player-births.json 재로드');
});

// 선수 데이터에 생년 주입
function injectBirthYears(players) {
  // 이름+소속 기준으로 중복 선수 파악
  const nameAffCount = new Map();
  for (const p of players) {
    const k = `${p.name}|${p.affiliation}`;
    nameAffCount.set(k, (nameAffCount.get(k) || 0) + 1);
  }
  // 중복인 선수에게만 생년 추가
  const nameAffIdx = new Map(); // 같은 이름+소속 내 순서 추적
  return players.map(p => {
    const k = `${p.name}|${p.affiliation}`;
    if (p.teamType === '단체') return p;
    if ((nameAffCount.get(k) || 0) <= 1) return p;
    if (p.birthYear) return p;                    // 스크래퍼 파싱 생년 유지
    const births = playerBirthsDB.get(k);
    if (!births) return p;                        // DB 없어도 기존 데이터 유지
    const idx = nameAffIdx.get(k) || 0;
    nameAffIdx.set(k, idx + 1);
    return { ...p, birthYear: births[idx] || '' };
  });
}

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
const SYSTEM_PROMPT = `당신은 SEEA Precision AI입니다. 한국 사격 선수·코치·심판을 위한 ISSF 규정 전문 어시스턴트입니다.

[핵심 규칙]
1. 항상 한국어로 답변하세요.
2. 첨부된 ISSF 공식 규정집을 최우선 참조하세요.
3. 규정 조항 번호를 반드시 인용하세요 (예: GTR 6.15.1, TR 6.4.1.2).
4. 규정집에서 확인되지 않는 내용은 "규정집에서 확인되지 않습니다. 원문을 직접 확인하세요"라고 명시하세요.
5. 모든 답변 끝에 반드시 추가: "⚠️ 참고용 답변입니다. 공식 원문 확인 필수."
6. ISSF 규정 외 질문(기술, 훈련, 장비 구매 등)은 "ISSF 규정 관련 질문을 해주세요."로 안내하세요.
7. 답변은 2~4문장 이내로 간결하게. 핵심 → 맥락 순서로. 불필요한 반복·부연 생략.

[종목 확인 규칙]
8. 질문에 종목이 명시되지 않으면 해당 분류의 종목 목록을 번호로 제시하고 선택을 요청하세요. 모든 종목을 한꺼번에 답변하지 마세요.
9. 아래 키워드가 있으면 종목 확인 없이 즉시 답변하세요:
   공기소총/AR/10m소총 → 10m 공기소총 | 공기권총/AP/10m권총 → 10m 공기권총
   3자세/3P → 50m 소총 3자세 | 복사/PR → 50m 소총 복사
   25m권총/RF/래피드파이어 → 25m 권총 | 스포츠권총/SP → 25m 스포츠 권총
   트랩/Trap → 트랩 | 더블트랩 → 더블 트랩 | 스키트/Skeet → 스키트

[한국 용어 규칙]
10. "본선" = ISSF "Qualification". 사용자가 "본선"이라고 하면 Qualification 규정으로 답변하세요.
    사용자 질문에 "본선"이 직접 포함된 경우에만, 딱 한 번: "※ 한국의 '본선'은 ISSF 공식 용어로 'Qualification(예선)'입니다. '결선(Final)'은 상위 선수들의 별도 경기입니다."
11. "결선" = ISSF "Final". 답변에서 "예선"이라는 표현 대신 "본선(Qualification)"을 사용하세요.

[동점 처리 — 반드시 우선 적용]
12. 소수점 채점 종목(10m 공기소총, 50m 소총 복사) 동점: GTR 6.15.1 f 적용.
    순서: ① 마지막 10발 시리즈 소수점 비교 → ② 마지막 발부터 한 발씩 소수점 비교.
    ❌ 이너 텐(X-ten) 개수는 이 종목의 동점 기준이 아님 (정수 채점 종목에만 적용).
13. 정수 채점 종목(10m 공기권총, 25m 권총, 25m 스포츠 권총) 동점: GTR 6.15.1 a~e 적용.
    순서: ① X-ten 개수 → ② 마지막 시리즈부터 역순 정수 비교 → ③ 마지막 발부터 X-ten 비교 → ④ EST 소수점 비교 → ⑤ 공동 순위(알파벳순).

[초과 발사 규정 — 반드시 두 조항을 함께 적용]
14. 선수가 종목 또는 자세에서 규정된 발수보다 많이 발사한 경우 (Rule 6.11.5):
    ① 초과 발은 마지막 표적에서 무효 처리 (식별 불가 시 최고점 발 무효)
    ② **추가로 초과 발 1발당 2점 감점** — 첫 번째 시리즈 최저점에서 차감
    ❌ "최저점 발 제외만" 또는 "감점 없음"으로 답변하는 것은 오답임. 두 조항이 동시에 적용됨.`;

// ── 규정집 업로드 (Gemini Files API) ──────────────────────
let rulesFileUri   = null;
let rulesUploading = false;

const RULES_FILENAME = 'Eng_ISSF_rules_2026.01.01.md';

async function uploadRulesPDF() {
  if (!process.env.GEMINI_API_KEY) return;

  const rulesDir = path.join(__dirname, 'rules');
  let pdfPath = null;
  try {
    const filePath = path.join(rulesDir, RULES_FILENAME);
    if (fs.existsSync(filePath)) pdfPath = filePath;
  } catch { /* 폴더 없으면 무시 */ }

  if (!pdfPath) {
    console.log(`    📄 규정집 없음 — rules/${RULES_FILENAME} 파일을 넣으면 자동 학습됩니다`);
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
        Buffer.from(`\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`),
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
            'X-Goog-Upload-Header-Content-Type':   'text/plain; charset=utf-8',
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

        // 규정집 파일을 첫 번째 user 메시지에 합쳐서 turn 구조 유지
        const geminiMessages = [];

        if (rulesFileUri) {
          const [first, ...rest] = messages;
          geminiMessages.push({
            role: 'user',
            parts: [
              { fileData: { mimeType: 'text/plain', fileUri: rulesFileUri } },
              { text: first.content },
            ],
          });
          for (const m of rest) {
            geminiMessages.push({
              role:  m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content }],
            });
          }
        } else {
          for (const m of messages) {
            geminiMessages.push({
              role:  m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content }],
            });
          }
        }

        const apiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
              contents: geminiMessages,
              generationConfig: { maxOutputTokens: 2048, temperature: 0.3 },
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

  // ── GET /api/bib-warm?comp=N01H ─────────────────────────
  // 대회 선택 시 미리 캐시 워밍 (검색 전 백그라운드 로딩)
  if (req.method === 'GET' && req.url.startsWith('/api/bib-warm')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp') || '').trim();
    if (!comp) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'comp 파라미터가 필요합니다.' }));
      return;
    }
    const cached = compPlayersCache.get(comp);
    const isWarm = cached && Date.now() - cached.ts < 12 * 60 * 60 * 1000;
    if (!isWarm) {
      // 즉시 응답하고 백그라운드에서 데이터 로딩
      searchBib(comp, '', 'name').then(result => {
        if (result.ok && result.allPlayers?.length) {
          compPlayersCache.set(comp, { players: result.allPlayers, ts: Date.now() });
          console.log(`[WARM] ${comp} 캐시 완료 — ${result.allPlayers.length}명`);
        }
      }).catch(e => console.log(`[WARM] ${comp} 캐시 실패: ${e.message}`));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ cached: isWarm }));
    return;
  }

  // ── GET /api/player-results?comp=N01H&name=홍길동 ────────
  if (req.method === 'GET' && req.url.startsWith('/api/player-results')) {
    const params      = new URL(req.url, 'http://localhost').searchParams;
    const comp        = (params.get('comp') || '').trim();
    const name        = decodeURIComponent(params.get('name') || '').trim();
    const birthYear   = (params.get('birthYear') || '').trim();
    const affiliation = decodeURIComponent(params.get('affiliation') || '').trim();

    if (!comp || !name) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'comp와 name이 필요합니다.' }));
      return;
    }

    const cached = compPlayersCache.get(comp);
    if (!cached) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '대회 데이터가 아직 로드되지 않았습니다. 잠시 후 다시 시도해주세요.' }));
      return;
    }

    const playerEvents = cached.players.filter(p => {
      if (p.name !== name || !p.personUrl) return false;
      // 생년 필터
      if (birthYear && p.birthYear && p.birthYear !== birthYear) return false;
      // 소속 필터
      if (affiliation && p.affiliation && p.affiliation !== affiliation) return false;
      return true;
    });
    if (!playerEvents.length) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '해당 선수의 경기 정보를 찾을 수 없습니다.' }));
      return;
    }

    // personUrl 기준 중복 제거
    const seen = new Set();
    const uniqueEvents = playerEvents.filter(p => {
      if (seen.has(p.personUrl)) return false;
      seen.add(p.personUrl);
      return true;
    });

    const POSITION_LABELS = ['슬사','복사','입사','서서','무릎','엎드려',
                             '8s','6s','4s','8초','6초','4초',
                             '완사','급사','150s','20s','10s'];

    // 자세 소계 추출: 총점 바로 앞 숫자값, 없으면 행 내 최대값
    const getPosSubtotal = (row, totalStr) => {
      const isS = v => v && /^\d{2,}[\d.]*$/.test((v||'').trim());
      const totalNum = parseFloat(totalStr);
      const ti = row.indexOf(totalStr);
      if (ti >= 0) {
        for (let i = ti - 1; i >= 3; i--) {
          const v = (row[i] || '').trim();
          if (isS(v) && parseFloat(v) < totalNum) return v;
        }
        return '';
      }
      let maxV = 0, maxStr = '';
      for (let i = 3; i < row.length; i++) {
        const v = (row[i] || '').trim();
        if (isS(v) && parseFloat(v) > maxV) { maxV = parseFloat(v); maxStr = v; }
      }
      return maxStr;
    };

    // KSF 행 파싱: colspan 때문에 헤더 인덱스 불일치 → 최대값=본선합계, 그 뒤=기록/결선
    const parsePlayerResult = row => {
      const RECORDS = ['대회신','한국신','세계신','아시아신','주니어신','학생신'];
      const isRec   = v => RECORDS.some(w => (v||'').includes(w));
      const isEmpty = v => !v || ['-','.',''].includes((v||'').trim());
      const isScore      = v => v && /^\d{2,}[\d.]*(-\d+x?)?$/.test(v);
      const isFinalScore = v => v && /^\d+[\d.]*(-\d+x?)?$/.test(v);

      // 최대값 = 본선합계
      let score = '', scoreIdx = -1, bestNum = 0;
      for (let i = 3; i < row.length; i++) {
        const v = row[i];
        if (isScore(v)) {
          const n = parseFloat(v);
          if (n > bestNum) { bestNum = n; score = v; scoreIdx = i; }
        }
      }
      if (!score) return { score:'', record:'', final:'', finalRecord:'' };

      // 본선합계 직후 기록 표시 탐색
      let record = '';
      for (let i = scoreIdx + 1; i < row.length; i++) {
        const v = row[i];
        if (isRec(v)) { record = v; break; }
        if (!isEmpty(v)) break;
      }

      // 결선 점수 탐색 (본선합계보다 작은 다음 숫자 — 1자리 포함)
      let final = '', finalIdx = -1;
      for (let i = scoreIdx + 1; i < row.length; i++) {
        const v = row[i];
        if (isFinalScore(v) && parseFloat(v) < bestNum) { final = v; finalIdx = i; break; }
      }

      // 결선 직후 기록 표시 탐색
      let finalRecord = '';
      for (let i = finalIdx + 1; finalIdx >= 0 && i < row.length; i++) {
        const v = row[i];
        if (isRec(v)) { finalRecord = v; break; }
        if (!isEmpty(v)) break;
      }

      return { score, record, final, finalRecord };
    };

    try {
      const results = await Promise.all(uniqueEvents.map(async p => {
        try {
          const cKey    = 'bib-result:' + p.personUrl;
          const now     = Date.now();
          const cached2 = rankingsCache.get(cKey);
          const data    = (cached2 && now - cached2.ts < 5 * 60 * 1000)
            ? cached2.data
            : await getEventRankings(p.personUrl);
          if (!cached2) rankingsCache.set(cKey, { data, ts: now });

          const { rows = [], headers = [] } = data;
          if (!rows.length) return { event: p.event, rank: '', score: '', record: '', final: '', finalRecord: '', total: 0, date: p.scheduleDate, affiliation: p.affiliation };

          // 실제 선수 수: 이름(row[2]) 기준 중복 제거 (3자세 Format B 포맷 대응)
          const mainRowsRaw = rows.filter(r => /^\d+$/.test((r[0]||'').trim()));
          const playerByName = new Map();
          for (const r of mainRowsRaw) {
            const n = (r[2] || '').trim();
            if (!n) continue;
            const p2 = parsePlayerResult(r);
            const s  = parseFloat(p2.score) || 0;
            if (!playerByName.has(n) || s > playerByName.get(n).score) {
              playerByName.set(n, { row: r, score: s });
            }
          }
          const playerCount = playerByName.size || mainRowsRaw.length;

          // 대상 선수 행: 이름 포함 행 중 점수 최대 행 선택 — 소속 필터로 동명이인 구분
          const targetAff = (p.affiliation || '').trim();
          let playerRow = null, parsed = {};
          for (const r of rows) {
            if (!(r[2] || '').includes(name)) continue;
            if (targetAff && (r[1] || '').trim() && !(r[1] || '').includes(targetAff)) continue;
            const p2 = parsePlayerResult(r);
            const s  = parseFloat(p2.score) || 0;
            if (s > (parseFloat(parsed.score) || 0)) { playerRow = r; parsed = p2; }
          }

          // 본선등위: 모든 메인 행을 점수 기준 정렬 후 playerRow의 순위 산출
          let qualRank = '';
          if (parsed.score && playerRow && mainRowsRaw.length > 0) {
            const allScored = mainRowsRaw.map(r => ({
              row: r,
              score: parseFloat(parsePlayerResult(r).score) || 0,
            })).sort((a, b) => b.score - a.score);
            const qi = allScored.findIndex(q => q.row === playerRow);
            if (qi >= 0) qualRank = String(qi + 1);
          }

          // 3자세/속사권총/25m권총 등 자세별 sub-row 파싱 (Format A/B 모두 지원)
          const positions = [];
          if (playerRow && POSITION_LABELS.includes(playerRow[3])) {
            const playerMainIdx = rows.indexOf(playerRow);
            const namedPosRows  = rows.filter(r =>
              (r[2] || '').includes(name) && POSITION_LABELS.includes(r[3]));
            if (namedPosRows.length > 1) {
              // 동명이인 혼재 방지: playerRow와 같은 등위 행만 사용
              const playerRank   = (playerRow[0] || '').trim();
              const sameRankRows = namedPosRows.filter(r => (r[0] || '').trim() === playerRank);
              const posRows      = sameRankRows.length > 0 ? sameRankRows : namedPosRows;
              for (const pr of posRows) {
                positions.push({ pos: pr[3], score: getPosSubtotal(pr, parsed.score) });
              }
            } else {
              positions.push({ pos: playerRow[3], score: getPosSubtotal(playerRow, parsed.score) });
              for (let si = playerMainIdx + 1; si < rows.length; si++) {
                const sr = rows[si];
                if (!POSITION_LABELS.includes(sr[0])) break;
                positions.push({ pos: sr[0], score: getPosSubtotal(sr, parsed.score) });
              }
            }
          }

          // 헤더 기반 자세 폴백 (속사 권총 등 단일행 포맷 — 선수당 1행, 자세명이 th에만 있는 경우)
          if (positions.length === 0 && headers.length > 0 && playerRow) {
            headers.forEach((h, hi) => {
              if (!POSITION_LABELS.includes(h.trim())) return;
              const val = (playerRow[hi] || '').trim();
              if (val && /^\d{2,}[\d.]*$/.test(val) && parseFloat(val) < parseFloat(parsed.score)) {
                positions.push({ pos: h.trim(), score: val });
              }
            });
          }

          // 속사 권총 전반/후반 형식: 전반/후반 행을 합산하여 8s/6s/4s 계산
          if (positions.length === 0 && playerRow && ['전반', '후반'].includes(playerRow[3])) {
            const mainOffset    = 4;
            const totalIdx      = playerRow.indexOf(parsed.score);
            if (totalIdx > mainOffset + 1) {
              const numStages      = totalIdx - 1 - mainOffset;
              const playerMainIdx  = rows.indexOf(playerRow);
              const rounds         = [{ row: playerRow, offset: mainOffset }];
              for (let si = playerMainIdx + 1; si < rows.length; si++) {
                const sr  = rows[si];
                const sr0 = (sr[0] || '').trim();
                if (!['전반', '후반'].includes(sr0)) break;
                rounds.push({ row: sr, offset: 1 });
              }
              const defaultLabels = { 3: ['8s','6s','4s'], 2: ['완사','급사'] };
              const stageLabels   = defaultLabels[numStages] || Array.from({ length: numStages }, (_, i) => `${i+1}`);
              for (let si = 0; si < numStages; si++) {
                let tot = 0;
                for (const { row: rr, offset } of rounds) {
                  tot += parseFloat(rr[offset + si] || '') || 0;
                }
                if (tot > 0) positions.push({ pos: stageLabels[si], score: String(Math.round(tot * 10) / 10) });
              }
            }
          }

          // 정수 경기 소수점 .0 제거 (10m 공기소총·50m 복사 외)
          const isDecimalEvent = /10m.*공기소총|50m.*복사/.test(p.event || '');
          const stripDotZero   = s => s && !isDecimalEvent ? s.replace(/\.0(-|$)/, '$1') : s;

          return {
            event:       p.event,
            rank:        playerRow ? (playerRow[0] || '') : '',
            qualRank,
            score:       stripDotZero(parsed.score       || ''),
            record:      parsed.record      || '',
            final:       parsed.final       || '',   // 결선은 항상 소수점 유지
            finalRecord: parsed.finalRecord || '',
            positions:   positions.map(pos => ({ ...pos, score: stripDotZero(pos.score) })),
            total:       playerCount || rows.length,
            date:        p.scheduleDate,
            affiliation: p.affiliation,
          };
        } catch (e) {
          return { event: p.event, rank: '', score: '', total: 0, date: p.scheduleDate, affiliation: p.affiliation };
        }
      }));

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, name, affiliation: uniqueEvents[0]?.affiliation || '', results }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /api/bib?comp=N01H&name=홍길동 ──────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/bib') &&
      !req.url.startsWith('/api/bib-debug') && !req.url.startsWith('/api/bib-adjacent') &&
      !req.url.startsWith('/api/bib-result') && !req.url.startsWith('/api/bib-warm')) {
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
      const BIB_CACHE_TTL = 12 * 60 * 60 * 1000; // 12시간
      const cached = compPlayersCache.get(comp);
      let allPlayers;

      if (cached && Date.now() - cached.ts < BIB_CACHE_TTL) {
        // 캐시 히트 → 로컬 검색만 (즉시 응답)
        console.log(`[/api/bib] 캐시 히트 — ${comp}, "${name}" (${cached.players.length}명 중 검색)`);
        allPlayers = cached.players;
      } else {
        // 캐시 미스 → KSF 스크래핑 후 캐시 저장
        const result = await searchBib(comp, name, searchMode);
        if (result.ok && result.allPlayers?.length) {
          compPlayersCache.set(comp, { players: result.allPlayers, ts: Date.now() });
        }
        if (!result.ok) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
          return;
        }
        allPlayers = result.allPlayers || [];
      }

      const searchLower = name.toLowerCase();
      const rawMatched = searchMode === 'team'
        ? allPlayers.filter(p => p.affiliation && p.affiliation.toLowerCase().includes(searchLower))
        : allPlayers.filter(p => p.name.includes(name));
      // 이름+소속 기준 동명이인에 생년 주입 (전체 대회 선수 기준으로 중복 판단)
      const matched = injectBirthYears(rawMatched);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, total: allPlayers.length, matched, searchMode }));
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
    if (cached && Date.now() - cached.ts < 12 * 60 * 60 * 1000) {
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

  // ── GET /api/bib-result?comp=N01H&event=…&name=…&isTeam=0 ──
  if (req.method === 'GET' && req.url.startsWith('/api/bib-result')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp')  || '').trim();
    const event  = decodeURIComponent(params.get('event') || '').trim();
    const name   = decodeURIComponent(params.get('name')  || '').trim();
    const isTeam = params.get('isTeam') === '1';

    const cached = compPlayersCache.get(comp);
    if (!cached) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '대회 데이터가 없습니다. 사대번호 검색을 먼저 해주세요.' }));
      return;
    }

    const player = cached.players.find(p =>
      p.event === event && p.name === name
    );
    if (!player) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '결과 페이지 링크를 찾을 수 없습니다.' }));
      return;
    }

    const rankUrl = player.personUrl;
    if (!rankUrl) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '이 종목의 결과가 아직 게시되지 않았습니다.' }));
      return;
    }

    try {
      const now     = Date.now();
      const cKey    = 'bib-result:' + rankUrl;
      const cached2 = rankingsCache.get(cKey);
      if (cached2 && now - cached2.ts < 5 * 60 * 1000) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(cached2.data));
        return;
      }
      const data = await getEventRankings(rankUrl);
      rankingsCache.set(cKey, { data, ts: now });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('[/api/bib-result]', err.message);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '결과 조회 실패: ' + err.message }));
    }
    return;
  }

  // ── GET /api/bib-adjacent?comp=N01H&event=…&group=2&lane=C ──
  if (req.method === 'GET' && req.url.startsWith('/api/bib-adjacent')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp')  || '').trim();
    const event  = (params.get('event') || '').trim();
    const group  = (params.get('group') || '').trim();
    const lane   = (params.get('lane')  || '').trim();
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
      // 속사(알파벳 사대)와 일반(숫자 사대) 모두 처리
      const isAlpha = /^[A-Za-z]+$/.test(lane);
      const groupPlayers = players
        .filter(p => p.event === event && p.group === group)
        .sort((a, b) => isAlpha
          ? a.lane.localeCompare(b.lane)
          : parseInt(a.lane) - parseInt(b.lane));
      const idx  = groupPlayers.findIndex(p => p.lane === lane);
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

  // ── GET /api/player-names?comp=N01H ─────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/player-names')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp') || '').trim();
    if (!comp) { res.writeHead(400); res.end(JSON.stringify({ names: [] })); return; }
    const cached = compPlayersCache.get(comp);
    if (cached && cached.players?.length) {
      const names = [...new Set(cached.players.map(p => p.name).filter(Boolean))]
        .sort(() => Math.random() - 0.5).slice(0, 40);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ names }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ names: [], warming: true }));
    }
    return;
  }

  // ── GET /api/feed  |  POST /api/feed  |  DELETE /api/feed ──
  const ADMIN_PW  = process.env.ADMIN_PASSWORD || 'kimchi5841*';
  const SB_URL    = process.env.SUPABASE_URL;
  const SB_KEY    = process.env.SUPABASE_ANON_KEY;
  const sbHeaders = {
    'Content-Type':  'application/json',
    'apikey':        SB_KEY || '',
    'Authorization': `Bearer ${SB_KEY || ''}`,
  };

  if (req.url.startsWith('/api/feed')) {
    if (!SB_URL || !SB_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Supabase 미설정' }));
      return;
    }

    if (req.method === 'GET') {
      try {
        const sbRes = await fetch(`${SB_URL}/rest/v1/ideas?order=ts.desc&limit=60`, { headers: sbHeaders });
        const data  = await sbRes.json();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(Array.isArray(data) ? data : []));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        try {
          const { name, msg } = JSON.parse(body);
          const text = (msg || '').trim().slice(0, 120);
          if (!text) { res.writeHead(400); res.end(); return; }
          const sbRes = await fetch(`${SB_URL}/rest/v1/ideas`, {
            method:  'POST',
            headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
            body:    JSON.stringify({
              name: (name || '익명').trim().slice(0, 20) || '익명',
              msg:  text,
              ts:   Date.now(),
            }),
          });
          if (!sbRes.ok) throw new Error(`Supabase ${sbRes.status}`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }

    if (req.method === 'DELETE') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        try {
          const { ts: delTs, pw } = JSON.parse(body);
          if (pw !== ADMIN_PW) { res.writeHead(403); res.end(JSON.stringify({ error: '비밀번호가 틀렸습니다.' })); return; }
          const sbRes = await fetch(`${SB_URL}/rest/v1/ideas?ts=eq.${delTs}`, {
            method:  'DELETE',
            headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
          });
          if (!sbRes.ok) throw new Error(`Supabase ${sbRes.status}`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }
  }

  // ── GET /api/comp-list ──────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/comp-list') {
    try {
      const now = Date.now();
      if (!compListCache || now - compListCache.ts > 30 * 60 * 1000) {
        compListCache = { data: await getCompList(), ts: now };
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(compListCache.data));
    } catch (err) {
      console.error('[/api/comp-list]', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /api/comp-events?comp=N01H ──────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/comp-events')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp') || '').trim();
    if (!comp) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'comp 파라미터가 필요합니다.' }));
      return;
    }
    try {
      const { html, events } = await getGamePageHtml(comp);
      const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title  = titleM ? titleM[1].trim() : comp;

      // personUrl로 중복 제거 (같은 종목의 여러 조를 하나로)
      const seenPerson = new Set();
      const unique = [];
      for (const evt of events) {
        const key = evt.personUrl || `${evt.eventLabel}|${evt.scheduleDate}`;
        if (!seenPerson.has(key)) {
          seenPerson.add(key);
          unique.push({
            eventLabel:   evt.eventLabel,
            personUrl:    evt.personUrl,
            groupUrl:     evt.groupUrl,
            scheduleDate: evt.scheduleDate,
            scheduleTime: evt.scheduleTime,
          });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ comp, title, events: unique }));
    } catch (err) {
      console.error('[/api/comp-events]', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /api/event-rankings?url=...&type=person|group ───
  if (req.method === 'GET' && req.url.startsWith('/api/event-rankings')) {
    const params  = new URL(req.url, 'http://localhost').searchParams;
    const rankUrl = decodeURIComponent(params.get('url') || '').trim();
    if (!rankUrl.startsWith('https://www.shooting.or.kr/') &&
        !rankUrl.startsWith('http://www.shooting.or.kr/')) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '허용되지 않는 URL입니다.' }));
      return;
    }
    try {
      const now    = Date.now();
      const cached = rankingsCache.get(rankUrl);
      if (cached && now - cached.ts < 5 * 60 * 1000) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(cached.data));
        return;
      }
      const data = await getEventRankings(rankUrl);
      rankingsCache.set(rankUrl, { data, ts: now });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('[/api/event-rankings]', err.message);
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

  const serveFile = (filePath, data, stat) => {
    const ext         = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const isHtml      = ext === '.html' || ext === '';
    // ETag = mtime 기반 (배포 시 파일 변경 → ETag 변경 → 브라우저 자동 갱신)
    const etag        = `"${stat.mtimeMs.toString(36)}"`;
    const cacheCtrl   = isHtml
      ? 'no-cache'                    // HTML: 항상 서버에 확인 (304 활용)
      : 'public, max-age=3600';       // 기타: 1시간 캐시

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cacheCtrl });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type':  contentType,
      'Cache-Control': cacheCtrl,
      'ETag':          etag,
    });
    res.end(data);
  };

  fs.stat(fullPath, (statErr, stat) => {
    if (statErr) {
      // 파일 없으면 index.html 폴백 (SPA 라우팅)
      const idxPath = path.join(__dirname, 'index.html');
      fs.stat(idxPath, (s2Err, s2) => {
        if (s2Err) { res.writeHead(404); res.end('Not found'); return; }
        fs.readFile(idxPath, (e2, idx) => {
          if (e2) { res.writeHead(404); res.end('Not found'); return; }
          serveFile(idxPath, idx, s2);
        });
      });
      return;
    }
    fs.readFile(fullPath, (err, data) => {
      if (err) { res.writeHead(500); res.end('Read error'); return; }
      serveFile(fullPath, data, stat);
    });
  });
});

server.listen(PORT, () => {
  const hasKey = !!process.env.GEMINI_API_KEY;
  console.log('\n🎯  SEEA Precision 서버 시작');
  console.log(`    URL : http://localhost:${PORT}`);
  console.log(`    API : ${hasKey ? '✅  연결됨 (gemini-2.0-flash)' : '⚠️   GEMINI_API_KEY 없음 → UI 전용 모드'}`);
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

  // 진행중 대회 자동 캐시 pre-warm (서버 재시작 후 첫 검색도 빠르게)
  const warmOngoing = () => getCompList().then(comps => {
    const ongoing = comps.filter(c => c.status === 'ongoing');
    if (ongoing.length === 0) return;
    console.log(`[PREWARM] 진행중 대회 ${ongoing.length}개 캐시 워밍 시작...`);
    for (const comp of ongoing) {
      searchBib(comp.jname, '', 'name').then(result => {
        if (result.ok && result.allPlayers?.length) {
          compPlayersCache.set(comp.jname, { players: injectBirthYears(result.allPlayers), ts: Date.now() });
          console.log(`[PREWARM] ${comp.jname} (${comp.name}) 완료 — ${result.allPlayers.length}명`);
        }
      }).catch(e => console.log(`[PREWARM] ${comp.jname} 실패: ${e.message}`));
    }
  }).catch(e => console.log(`[PREWARM] 대회 목록 조회 실패: ${e.message}`));

  warmOngoing();
  // 1시간마다 재워밍 (12시간 TTL 내에서도 데이터 최신 유지)
  setInterval(warmOngoing, 60 * 60 * 1000);

  // KSF 대회 목록 감시 시작
  startWatcher();
});
