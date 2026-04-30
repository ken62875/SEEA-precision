/**
 * KSF 대회 목록 감시기
 * - score_2015_list.asp 를 주기적으로 폴링
 * - 새로 활성화된 대회(jname 링크) 감지 시 사대번호 크롤링 → 이메일 알림
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { searchBib } from './bib-scraper.mjs';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'watcher-state.json');

const KSF_LIST_URL    = 'https://www.shooting.or.kr/score/score_2015_list.asp';
const POLL_INTERVAL   = 60 * 60 * 1000; // 1시간

// 알림 받을 이메일 목록 (테스트)
const SUBSCRIBERS = ['ken628@naver.com'];

// ── EUC-KR fetch ──────────────────────────────────────────
async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      'Referer':         'https://www.shooting.or.kr',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);

  const buf = await res.arrayBuffer();
  try { return new TextDecoder('euc-kr', { fatal: false }).decode(buf); }
  catch { return new TextDecoder('utf-8', { fatal: false }).decode(buf); }
}

// ── 목록 페이지 파싱 → 활성화된 대회만 반환 ─────────────
function parseCompList(html) {
  const active = [];

  // <td class="title"> 안에 <a href="score_2015_game.asp?jname=..."> 가 있는 행만 추출
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const rowM of html.matchAll(rowRe)) {
    const row = rowM[1];

    const linkM = row.match(/href=["']([^"']*score_2015_game\.asp\?jname=([^"'&\s]+))[^"']*/i);
    if (!linkM) continue;

    const jname = linkM[2].trim();
    if (!jname) continue;

    // 대회명
    const nameM = row.match(/<td[^>]*class="title"[^>]*>([\s\S]*?)<\/td>/i);
    const name  = nameM
      ? nameM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      : jname;

    // 기간
    const dateM = row.match(/<td[^>]*class="date"[^>]*>([\s\S]*?)<\/td>/i);
    const date  = dateM
      ? dateM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      : '';

    active.push({ jname, name, date });
  }

  return active;
}

// ── 상태 파일 로드 / 저장 ────────────────────────────────
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { knownJnames: [], lastChecked: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ── Resend 이메일 발송 ───────────────────────────────────
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log('[WATCHER] RESEND_API_KEY 없음 — 이메일 발송 스킵');
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    'SEEA Precision <onboarding@resend.dev>',
      to,
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Resend 오류: ${err.message || res.status}`);
  }
  const data = await res.json();
  console.log(`[WATCHER] 이메일 발송 완료 → ${to.join(', ')} (id: ${data.id})`);
}

// ── 알림 이메일 HTML 생성 ────────────────────────────────
function buildEmailHtml(comp, playerCount) {
  return `
<!DOCTYPE html>
<html lang="ko">
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, sans-serif; background: #f5f5f5; padding: 24px;">
  <div style="max-width: 520px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,.08);">

    <div style="background: #0B1E3F; padding: 28px 32px;">
      <p style="color: #C9A24A; font-size: 13px; margin: 0 0 6px; font-weight: 600; letter-spacing: .05em;">SEEA PRECISION</p>
      <h1 style="color: #fff; font-size: 20px; margin: 0; font-weight: 700;">사대번호 배정 공개 알림</h1>
    </div>

    <div style="padding: 28px 32px;">
      <p style="color: #333; font-size: 15px; line-height: 1.6; margin: 0 0 20px;">
        아래 대회의 사대번호 배정표가 공개되었습니다.
      </p>

      <div style="background: #f8f9fa; border-radius: 8px; padding: 18px 20px; margin-bottom: 24px;">
        <p style="margin: 0 0 6px; font-size: 13px; color: #888;">대회명</p>
        <p style="margin: 0 0 14px; font-size: 16px; font-weight: 700; color: #0B1E3F;">${comp.name}</p>
        <p style="margin: 0 0 6px; font-size: 13px; color: #888;">기간</p>
        <p style="margin: 0; font-size: 15px; color: #333;">${comp.date || '일정 확인 필요'}</p>
      </div>

      <p style="color: #555; font-size: 14px; margin: 0 0 6px;">
        총 <strong>${playerCount}명</strong>의 선수 사대번호가 등록되어 있습니다.
      </p>

      <a href="http://seea.kr"
         style="display: inline-block; margin-top: 20px; background: #C9A24A; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 700; font-size: 15px;">
        사대번호 확인하기 →
      </a>
    </div>

    <div style="padding: 16px 32px; border-top: 1px solid #eee;">
      <p style="color: #aaa; font-size: 12px; margin: 0;">
        본 메일은 SEEA Precision 사대번호 알림 서비스에서 발송되었습니다.
      </p>
    </div>

  </div>
</body>
</html>
  `.trim();
}

// ── 메인 폴링 함수 ───────────────────────────────────────
async function poll() {
  console.log(`\n[WATCHER] 폴링 시작 — ${new Date().toLocaleString('ko-KR')}`);

  let html;
  try {
    html = await fetchHtml(KSF_LIST_URL);
  } catch (e) {
    console.log(`[WATCHER] 목록 페이지 fetch 실패: ${e.message}`);
    return;
  }

  const active = parseCompList(html);
  console.log(`[WATCHER] 활성 대회 ${active.length}개 감지: ${active.map(c => c.jname).join(', ') || '없음'}`);

  const state    = loadState();
  const known    = new Set(state.knownJnames || []);
  const isFirst  = known.size === 0;

  const newComps = active.filter(c => !known.has(c.jname));

  // 최초 실행 시 현재 상태를 기준선으로만 저장 (알림 발송 안 함)
  if (isFirst) {
    state.knownJnames = active.map(c => c.jname);
    state.lastChecked = new Date().toISOString();
    saveState(state);
    console.log(`[WATCHER] 최초 실행 — 기준선 설정 완료 (${active.length}개 대회 등록)`);
    return;
  }

  if (newComps.length === 0) {
    state.lastChecked = new Date().toISOString();
    saveState(state);
    console.log('[WATCHER] 새 대회 없음');
    return;
  }

  // 새 대회 처리
  for (const comp of newComps) {
    console.log(`[WATCHER] ★ 새 대회 감지: ${comp.name} (${comp.jname})`);

    // 사대번호 크롤링 (전체 선수 수 파악용 — 빈 검색어 대신 공통 문자 사용)
    let playerCount = 0;
    try {
      // 모든 선수를 가져오기 위해 빈 문자열 대신 매우 짧은 공통 문자로 검색
      const result = await searchBib(comp.jname, '', 'name');
      if (result.ok) playerCount = result.total;
    } catch (e) {
      console.log(`[WATCHER] 사대번호 크롤링 오류: ${e.message}`);
    }

    // 이메일 발송
    try {
      await sendEmail({
        to:      SUBSCRIBERS,
        subject: `[SEEA] 사대번호 배정 공개 — ${comp.name}`,
        html:    buildEmailHtml(comp, playerCount),
      });
    } catch (e) {
      console.log(`[WATCHER] 이메일 발송 오류: ${e.message}`);
    }

    known.add(comp.jname);
  }

  state.knownJnames = [...known];
  state.lastChecked = new Date().toISOString();
  saveState(state);
}

// ── 외부 노출 ────────────────────────────────────────────
export function startWatcher() {
  console.log(`\n[WATCHER] 감시 시작 — 폴링 간격: ${POLL_INTERVAL / 60000}분`);
  poll();
  setInterval(poll, POLL_INTERVAL);
}

// ── 수동 즉시 테스트용 (node watcher.mjs test) ───────────
if (process.argv[2] === 'test') {
  console.log('[WATCHER] 수동 테스트 모드');
  // 상태 파일 초기화 후 폴링 (강제 알림 발송 테스트)
  if (process.argv[3] === '--reset') {
    try { fs.unlinkSync(STATE_FILE); } catch { /* */ }
    console.log('[WATCHER] 상태 초기화 완료 — 다음 실행 시 기준선 재설정');
  }
  await poll();
  process.exit(0);
}
