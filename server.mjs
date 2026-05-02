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

        // 규정집이 업로드된 경우 첫 번째 컨텍스트로 삽입
        const geminiMessages = [];

        if (rulesFileUri) {
          geminiMessages.push({
            role: 'user',
            parts: [
              { fileData: { mimeType: 'text/plain', fileUri: rulesFileUri } },
              { text: '이 문서는 2026년 1월 1일 기준 ISSF 공식 규정집입니다. 이 문서를 기반으로 정확하게 답변해주세요.' },
            ],
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
              generationConfig: {
                maxOutputTokens: 2048,
                temperature: 0.3,
                thinkingConfig: { thinkingBudget: 0 },
              },
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

  // ── GET /api/feed  |  POST /api/feed ─────────────────────
  const FEED_FILE = path.join(__dirname, 'feed.json');
  function readFeed() {
    try { return JSON.parse(fs.readFileSync(FEED_FILE, 'utf8')); } catch { return []; }
  }
  function writeFeed(msgs) {
    try { fs.writeFileSync(FEED_FILE, JSON.stringify(msgs)); } catch {}
  }

  const ADMIN_PW = process.env.ADMIN_PASSWORD || 'kimchi5841*';

  if (req.url.startsWith('/api/feed')) {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(readFeed()));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const { name, msg } = JSON.parse(body);
          const text = (msg || '').trim().slice(0, 120);
          if (!text) { res.writeHead(400); res.end(); return; }
          const msgs = readFeed();
          msgs.unshift({ id: Date.now(), name: (name || '익명').trim().slice(0, 20) || '익명', msg: text, ts: Date.now() });
          writeFeed(msgs.slice(0, 60));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch { res.writeHead(400); res.end(); }
      });
      return;
    }
    if (req.method === 'DELETE') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const { ts: delTs, pw } = JSON.parse(body);
          if (pw !== ADMIN_PW) { res.writeHead(403); res.end(JSON.stringify({ error: '비밀번호가 틀렸습니다.' })); return; }
          const msgs = readFeed().filter(m => m.ts !== delTs);
          writeFeed(msgs);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch { res.writeHead(400); res.end(); }
      });
      return;
    }
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
