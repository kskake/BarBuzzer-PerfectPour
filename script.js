/**
 * The Perfect Pour — Game Logic
 * Fast-paced reflex game: stop the fill precisely on the target line.
 */

'use strict';

/* =====================================================================
   CONSTANTS
   ===================================================================== */
const TOTAL_ROUNDS            = 10;
const BASE_FILL_DURATION_MS   = 3400;   // ms to fill glass at base speed
const SPEED_INCREASE_ROUNDS   = 2;      // speed increases every N rounds
const SPEED_LINEAR_STEP       = 0.08;   // gentle linear gain per speed level (early rounds)
const SPEED_QUADRATIC_STEP    = 0.03;   // extra quadratic gain per level² (steeper later)
const MAX_SPEED_MULTIPLIER    = 3.0;    // cap to keep the game playable
const GLASS_CHANGE_ROUNDS     = 3;      // glass type rotates every N rounds
const DISTRACTION_START_ROUND = 5;      // distractions begin at this round
const SCORE_PERFECT           = 10;
const PERFECT_WINDOW          = 0.028;  // |delta| <= this → Perfect (generous for on-line stops)
const CLOSE_WINDOW            = 0.045;  // |delta| <= this → Close
const OFF_WINDOW              = 0.10;   // |delta| <= this → Off (beyond = Under)
const BUST_WINDOW             = 0.055;  // overshoot beyond this → Bust (allows foam + small visual error)
const STREAK_MULT_STEP        = 0.25;   // multiplier gained per streak level
const MAX_STREAK_MULT         = 3.0;    // multiplier cap
const FILL_LINE_JITTER        = 0.04;   // ± random offset applied to scheduled fill line
const FILL_LINE_MIN           = 0.50;   // keep jittered line within a sensible range
const FILL_LINE_MAX           = 0.85;
const SCORE_BUST              = -5;
const SCORE_UNDER             = 1;
const LEADERBOARD_KEY         = 'perfectPour_leaderboard';
const HIGH_SCORE_KEY          = 'perfectPour_highScore';

/** Per-round fill-line positions (fraction 0-1, from bottom of glass). */
const FILL_LINE_SCHEDULE = [0.70, 0.65, 0.75, 0.60, 0.80, 0.70, 0.55, 0.75, 0.68, 0.72];

/** Glass type cycling (every GLASS_CHANGE_ROUNDS rounds). */
const GLASS_TYPES = ['pint', 'cocktail', 'shot'];

/** Speed tier labels. */
const SPEED_LABELS = ['NORMAL', 'FAST', 'FASTER', 'RAPID', 'INSANE', 'LUDICROUS'];

/* =====================================================================
   STATE
   ===================================================================== */
const state = {
  phase:          'welcome',  // 'welcome' | 'idle' | 'pouring' | 'result' | 'gameover'
  round:          1,
  score:          0,
  streak:         0,          // consecutive Perfect/Close pours
  playerName:     'Anonymous',
  fillProgress:   0,          // 0–1
  fillLineFrac:   0.70,       // target line position (fraction from bottom)
  speedMultiplier: 1.0,
  glassType:      'pint',
  animFrameId:    null,
  pourStartTime:  null,
  distractionTimer: null,
};

/* =====================================================================
   DOM REFS
   ===================================================================== */
const welcomeScreen    = document.getElementById('welcomeScreen');
const gameScreen       = document.getElementById('gameScreen');
const gameOverScreen   = document.getElementById('gameOverScreen');

const playerNameInput  = document.getElementById('playerNameInput');
const welcomeHighScore = document.getElementById('welcomeHighScore');
const startGameBtn     = document.getElementById('startGameBtn');

const hudRound         = document.getElementById('hudRound');
const hudScore         = document.getElementById('hudScore');
const hudSpeed         = document.getElementById('hudSpeed');
const hudStreak        = document.getElementById('hudStreak');

const glassArea        = document.getElementById('glassArea');
const glassWrapper     = document.getElementById('glassWrapper');
const glassTypeLabel   = document.getElementById('glassTypeLabel');
const scorePopup       = document.getElementById('scorePopup');
const roundResult      = document.getElementById('roundResult');
const actionBtn        = document.getElementById('actionBtn');
const distractionOverlay = document.getElementById('distractionOverlay');

const gameOverTitle    = document.getElementById('gameOverTitle');
const gameOverSubtitle = document.getElementById('gameOverSubtitle');
const gameOverEmoji    = document.getElementById('gameOverEmoji');
const gameOverScore    = document.getElementById('gameOverScore');
const gameOverHighScore = document.getElementById('gameOverHighScore');
const newHighScoreBadge = document.getElementById('newHighScoreBadge');
const gameOverLeaderboardList = document.getElementById('gameOverLeaderboardList');
const playAgainBtn     = document.getElementById('playAgainBtn');

const welcomeLeaderboardList  = document.getElementById('welcomeLeaderboardList');
const welcomeLeaderboardEmpty = document.getElementById('welcomeLeaderboardEmpty');

/* =====================================================================
   SVG GLASS DEFINITIONS
   Coordinate space: viewBox "0 0 200 320" for pint/shot, adjusted for cocktail.
   Liquid fill rect is updated from bottom (y = (1-prog)*H, height = prog*H).
   ===================================================================== */

/** Returns SVG markup for each glass type. */
function buildGlassSVG(type, fillLineFrac) {
  switch (type) {
    case 'pint':     return buildPintSVG(fillLineFrac);
    case 'cocktail': return buildCocktailSVG(fillLineFrac);
    case 'shot':     return buildShotSVG(fillLineFrac);
    default:         return buildPintSVG(fillLineFrac);
  }
}

function buildPintSVG(fillLineFrac) {
  const W = 200, H = 300;
  const lineY = H * (1 - fillLineFrac);
  return `
<svg id="glassSVG" class="glass-svg" viewBox="0 0 ${W} ${H}"
     width="160" height="240"
     xmlns="http://www.w3.org/2000/svg"
     style="overflow:visible"
     aria-hidden="true">
  <defs>
    <linearGradient id="beerGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#ffe066" stop-opacity="0.95"/>
      <stop offset="60%"  stop-color="#f59e0b" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#b45309" stop-opacity="0.95"/>
    </linearGradient>
    <linearGradient id="foamGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#fffbeb" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#fde68a" stop-opacity="0.7"/>
    </linearGradient>
    <clipPath id="pintClip">
      <polygon points="22,2 178,2 163,298 37,298"/>
    </clipPath>
  </defs>

  <!-- Glass body (transparent fill, neon outline) -->
  <polygon id="glassOutline"
    points="20,0 180,0 165,300 35,300"
    fill="rgba(255,255,255,0.04)"
    stroke="rgba(0,212,255,0.45)"
    stroke-width="2.5"
    stroke-linejoin="round"/>

  <!-- Liquid fill (clipped to glass interior) -->
  <rect id="liquidRect"
    x="0" y="${H}" width="${W}" height="0"
    fill="url(#beerGrad)"
    clip-path="url(#pintClip)"
    opacity="0.92"/>

  <!-- Foam layer (top of liquid, 8px tall) -->
  <rect id="foamRect"
    x="0" y="${H}" width="${W}" height="0"
    fill="url(#foamGrad)"
    clip-path="url(#pintClip)"
    opacity="0.88"/>

  <!-- Glass shine -->
  <line x1="38" y1="12" x2="46" y2="288"
    stroke="rgba(255,255,255,0.12)" stroke-width="9" stroke-linecap="round"/>

  <!-- Fill line -->
  <line id="fillLine"
    x1="0" y1="${lineY}" x2="${W}" y2="${lineY + 0.1}"
    stroke="#00ffff" stroke-width="3"
    stroke-dasharray="10,5"
    filter="url(#lineGlow)"/>
  <defs>
    <filter id="lineGlow" x="-10%" y="-100%" width="120%" height="300%">
      <feGaussianBlur stdDeviation="2.5" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <!-- Over-fill warning zone (above the line) -->
  <rect id="dangerZone"
    x="0" y="0" width="${W}" height="${lineY}"
    fill="rgba(255,45,85,0.0)"
    clip-path="url(#pintClip)"
    pointer-events="none"/>
</svg>`;
}

function buildCocktailSVG(fillLineFrac) {
  /* Bowl: inverted triangle 0,0→200,0→120,200→80,200 */
  const W = 200, H = 200, STEM_H = 80;
  const lineY = H * (1 - fillLineFrac);
  return `
<svg id="glassSVG" class="glass-svg" viewBox="0 0 ${W} ${H + STEM_H}"
     width="160" height="${Math.round((H + STEM_H) * 0.8)}"
     xmlns="http://www.w3.org/2000/svg"
     style="overflow:visible"
     aria-hidden="true">
  <defs>
    <linearGradient id="cocktailGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#ff00a0" stop-opacity="0.9"/>
      <stop offset="50%"  stop-color="#9945ff" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#00d4ff" stop-opacity="0.9"/>
    </linearGradient>
    <clipPath id="cocktailClip">
      <polygon points="2,2 198,2 122,198 78,198"/>
    </clipPath>
    <filter id="lineGlowC" x="-10%" y="-100%" width="120%" height="300%">
      <feGaussianBlur stdDeviation="2.5" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <!-- Bowl outline -->
  <polygon id="glassOutline"
    points="0,0 200,0 122,200 78,200"
    fill="rgba(255,255,255,0.04)"
    stroke="rgba(153,69,255,0.55)"
    stroke-width="2.5"
    stroke-linejoin="round"/>

  <!-- Liquid fill -->
  <rect id="liquidRect"
    x="0" y="${H}" width="${W}" height="0"
    fill="url(#cocktailGrad)"
    clip-path="url(#cocktailClip)"
    opacity="0.9"/>

  <!-- Stem -->
  <rect x="96" y="${H}" width="8" height="${STEM_H - 14}"
    fill="rgba(153,69,255,0.35)" rx="2"/>

  <!-- Base -->
  <rect x="60" y="${H + STEM_H - 14}" width="80" height="14"
    fill="rgba(153,69,255,0.35)" rx="3"/>

  <!-- Glass shine -->
  <line x1="18" y1="8" x2="72" y2="185"
    stroke="rgba(255,255,255,0.1)" stroke-width="7" stroke-linecap="round"/>

  <!-- Fill line -->
  <line id="fillLine"
    x1="0" y1="${lineY}" x2="${W}" y2="${lineY + 0.1}"
    stroke="#00ffff" stroke-width="3"
    stroke-dasharray="10,5"
    filter="url(#lineGlowC)"/>
</svg>`;
}

function buildShotSVG(fillLineFrac) {
  const W = 120, H = 200;
  const lineY = H * (1 - fillLineFrac);
  return `
<svg id="glassSVG" class="glass-svg" viewBox="0 0 ${W} ${H}"
     width="96" height="160"
     xmlns="http://www.w3.org/2000/svg"
     style="overflow:visible"
     aria-hidden="true">
  <defs>
    <linearGradient id="shotGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#fffde7" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#ffd600" stop-opacity="0.9"/>
    </linearGradient>
    <clipPath id="shotClip">
      <polygon points="10,2 110,2 104,198 16,198"/>
    </clipPath>
    <filter id="lineGlowS" x="-10%" y="-100%" width="120%" height="300%">
      <feGaussianBlur stdDeviation="2" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <!-- Glass body -->
  <polygon id="glassOutline"
    points="8,0 112,0 106,200 14,200"
    fill="rgba(255,255,255,0.04)"
    stroke="rgba(255,215,0,0.55)"
    stroke-width="2.5"
    stroke-linejoin="round"/>

  <!-- Liquid fill -->
  <rect id="liquidRect"
    x="0" y="${H}" width="${W}" height="0"
    fill="url(#shotGrad)"
    clip-path="url(#shotClip)"
    opacity="0.9"/>

  <!-- Glass shine -->
  <line x1="20" y1="8" x2="25" y2="190"
    stroke="rgba(255,255,255,0.12)" stroke-width="6" stroke-linecap="round"/>

  <!-- Fill line -->
  <line id="fillLine"
    x1="0" y1="${lineY}" x2="${W}" y2="${lineY + 0.1}"
    stroke="#00ffff" stroke-width="3"
    stroke-dasharray="8,4"
    filter="url(#lineGlowS)"/>
</svg>`;
}

/* =====================================================================
   LEADERBOARD / HIGH SCORE HELPERS
   ===================================================================== */
function getHighScore() {
  return parseInt(localStorage.getItem(HIGH_SCORE_KEY) || '0', 10);
}

function saveHighScore(score) {
  localStorage.setItem(HIGH_SCORE_KEY, String(score));
}

function getLeaderboard() {
  try {
    return JSON.parse(localStorage.getItem(LEADERBOARD_KEY)) || [];
  } catch {
    return [];
  }
}

function addLeaderboardEntry(name, score) {
  const board = getLeaderboard();
  board.push({
    name: name.trim().slice(0, 20) || 'Anonymous',
    score,
    date: new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
  });
  board.sort((a, b) => b.score - a.score);
  board.splice(10);
  localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(board));
}

function renderLeaderboard(listEl, emptyEl) {
  const board = getLeaderboard();
  if (listEl) listEl.innerHTML = '';
  if (emptyEl) emptyEl.classList.toggle('hidden', board.length > 0);
  if (!listEl) return;

  const medals = ['🥇', '🥈', '🥉'];
  board.forEach((entry, i) => {
    const li = document.createElement('li');
    li.className = 'leaderboard-item';
    li.innerHTML = `
      <span class="leaderboard-rank">${medals[i] || (i + 1)}</span>
      <span class="leaderboard-name">${escapeHtml(entry.name)}</span>
      <span class="leaderboard-score">${entry.score}pts</span>
      <span class="leaderboard-date">${escapeHtml(entry.date)}</span>
    `;
    listEl.appendChild(li);
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* =====================================================================
   SCORING
   ===================================================================== */
/**
 * Score multiplier for a given streak: 1x base, +STREAK_MULT_STEP per level, capped.
 * @param {number} streak consecutive Perfect/Close pours
 */
function getStreakMultiplier(streak) {
  return Math.min(1 + streak * STREAK_MULT_STEP, MAX_STREAK_MULT);
}

/** Formats a multiplier for display, e.g. 1.5 → "x1.5". */
function formatMultiplier(mult) {
  return `x${Number(mult.toFixed(2))}`;
}

/**
 * Evaluate the player's fill stop against the target fill line.
 * Positive points are scaled by the streak multiplier (Under stays flat).
 * @param {number} fillProgress   0–1 (how full the glass is)
 * @param {number} fillLineFrac   0–1 target line (from bottom)
 * @param {number} [multiplier=1] current streak multiplier
 * @returns {{ result: string, points: number, label: string, color: string }}
 */
function evaluateScore(fillProgress, fillLineFrac, multiplier = 1) {
  const delta = fillProgress - fillLineFrac; // + = over, - = under

  // Grace for on-line / under stops and foam visual offset on the pint.
  // Only clearly over the line counts as a bust.
  if (delta > BUST_WINDOW) {
    return { result: 'bust',    points: SCORE_BUST, label: '💥 BUST!',          color: '#ff2d55' };
  }
  const absDelta = Math.abs(delta);
  if (absDelta <= PERFECT_WINDOW) {
    const pts = Math.round(SCORE_PERFECT * multiplier);
    return { result: 'perfect', points: pts,          label: `⭐ PERFECT POUR! +${pts}`, color: '#ffd700' };
  }
  if (absDelta <= CLOSE_WINDOW) {
    const closeness = 1 - (absDelta - PERFECT_WINDOW) / (CLOSE_WINDOW - PERFECT_WINDOW);
    const pts = Math.round((5 + closeness * 2) * multiplier);   // 5–7 base
    return { result: 'close',   points: pts,           label: `👍 CLOSE POUR! +${pts}`, color: '#00d4ff' };
  }
  if (absDelta <= OFF_WINDOW) {
    const closeness = 1 - (absDelta - CLOSE_WINDOW) / (OFF_WINDOW - CLOSE_WINDOW);
    const pts = Math.round((2 + closeness * 2) * multiplier);   // 2–4 base
    return { result: 'off',     points: pts,           label: `📏 NOT QUITE +${pts}`,  color: '#9945ff' };
  }
  return { result: 'under',   points: SCORE_UNDER,   label: `😅 UNDER POUR +${SCORE_UNDER}`, color: '#7888aa' };
}

/* =====================================================================
   GLASS RENDERING
   ===================================================================== */
/** Inject the SVG glass for the current round into the wrapper. */
function renderGlass() {
  const { glassType, fillLineFrac } = state;
  glassWrapper.innerHTML = buildGlassSVG(glassType, fillLineFrac);

  const labels = { pint: 'BEER PINT 🍺', cocktail: 'COCKTAIL GLASS 🍸', shot: 'SHOT GLASS 🥃' };
  glassTypeLabel.textContent = labels[glassType] || 'GLASS';

  // Reset fill
  updateLiquidFill(0);
}

/**
 * Update the SVG liquid fill to the given progress fraction.
 * @param {number} progress 0–1
 */
function updateLiquidFill(progress) {
  const svg = document.getElementById('glassSVG');
  if (!svg) return;

  const liquidRect = document.getElementById('liquidRect');
  const foamRect   = document.getElementById('foamRect');

  const svgVB   = svg.viewBox.baseVal;
  const H       = svgVB.height;
  const FOAM_H  = state.glassType === 'pint' ? 14 : 0; // foam only on pint

  if (liquidRect) {
    const liquidH = Math.max(0, progress * H - FOAM_H);
    const liquidY = H - liquidH - FOAM_H;
    liquidRect.setAttribute('y', liquidY);
    liquidRect.setAttribute('height', liquidH);
  }

  if (foamRect && FOAM_H > 0) {
    const foamH = Math.min(FOAM_H, progress * H);
    const foamY = H - (progress * H);
    foamRect.setAttribute('y', foamY);
    foamRect.setAttribute('height', foamH > 2 ? foamH : 0);
  }

  // Pulse the glass border based on proximity to fill line
  updateGlassPulse(progress);
}

/** Animate the glass border pulsing — faster as liquid nears the line. */
function updateGlassPulse(progress) {
  const svg = document.getElementById('glassSVG');
  if (!svg) return;

  const proximity = Math.max(0, 1 - Math.abs(progress - state.fillLineFrac) / 0.25);
  const pulseSpeed = Math.max(0.2, 1.2 - proximity * 1.0); // 1.2s → 0.2s

  svg.style.setProperty('--pulse-speed', `${pulseSpeed.toFixed(2)}s`);

  if (state.phase === 'pouring' && proximity > 0.15) {
    svg.classList.add('pulse-active');
  } else {
    svg.classList.remove('pulse-active');
  }
}

/* =====================================================================
   GAME FLOW
   ===================================================================== */
function initRound() {
  const round = state.round;

  // Speed multiplier: gentle early, steeper later (1 + 0.08L + 0.03L²), capped
  const speedLevels = Math.floor((round - 1) / SPEED_INCREASE_ROUNDS);
  state.speedMultiplier = Math.min(
    1 + SPEED_LINEAR_STEP * speedLevels + SPEED_QUADRATIC_STEP * speedLevels * speedLevels,
    MAX_SPEED_MULTIPLIER
  );

  // Glass type (cycles every GLASS_CHANGE_ROUNDS)
  const glassIndex = Math.floor((round - 1) / GLASS_CHANGE_ROUNDS) % GLASS_TYPES.length;
  state.glassType = GLASS_TYPES[glassIndex];

  // Fill line from schedule (loop if beyond length) plus random jitter for variety
  const scheduled = FILL_LINE_SCHEDULE[(round - 1) % FILL_LINE_SCHEDULE.length];
  const jitter = (Math.random() * 2 - 1) * FILL_LINE_JITTER;
  state.fillLineFrac = Math.min(FILL_LINE_MAX, Math.max(FILL_LINE_MIN, scheduled + jitter));

  state.fillProgress = 0;
  state.phase = 'idle';

  // Update HUD
  hudRound.textContent = `${round} / ${TOTAL_ROUNDS}`;
  hudScore.textContent = state.score;
  updateStreakHud(false);

  const speedTier = Math.min(speedLevels, SPEED_LABELS.length - 1);
  hudSpeed.textContent = SPEED_LABELS[speedTier];
  hudSpeed.style.color = speedTier >= 3 ? '#ff2d55' : speedTier >= 2 ? '#ff6b2b' : speedTier >= 1 ? '#ffd700' : '#00ff9d';

  // Render glass
  renderGlass();

  // Action button reset
  actionBtn.textContent = 'START POUR';
  actionBtn.classList.remove('pouring');
  actionBtn.disabled = false;

  // Hide result
  roundResult.classList.add('hidden');
  roundResult.textContent = '';

  // Hide score popup
  scorePopup.classList.add('hidden');
}

function startPour() {
  if (state.phase !== 'idle') return;
  state.phase = 'pouring';
  state.pourStartTime = performance.now();
  state.fillProgress = 0;

  actionBtn.textContent = 'STOP!';
  actionBtn.classList.add('pouring');

  // Schedule distractions from round 5+
  if (state.round >= DISTRACTION_START_ROUND) {
    scheduleDistraction();
  }

  state.animFrameId = requestAnimationFrame(animateFill);
}

function animateFill(timestamp) {
  if (state.phase !== 'pouring') return;

  const elapsed = timestamp - state.pourStartTime;
  const fillDuration = BASE_FILL_DURATION_MS / state.speedMultiplier;
  state.fillProgress = Math.min(elapsed / fillDuration, 1.0);

  updateLiquidFill(state.fillProgress);

  // Auto-bust if glass completely overflows (hit 100%)
  if (state.fillProgress >= 1.0) {
    stopPour(true);
    return;
  }

  state.animFrameId = requestAnimationFrame(animateFill);
}

function stopPour(autoBust) {
  if (state.phase !== 'pouring') return;
  state.phase = 'result';

  // Cancel animation loop
  if (state.animFrameId) {
    cancelAnimationFrame(state.animFrameId);
    state.animFrameId = null;
  }

  // Cancel any pending distraction
  if (state.distractionTimer) {
    clearTimeout(state.distractionTimer);
    state.distractionTimer = null;
  }

  const fill = autoBust ? 1.0 : state.fillProgress;
  const evaluation = autoBust
    ? { result: 'bust', points: SCORE_BUST, label: '💥 BUST! (Overflow)', color: '#ff2d55' }
    : evaluateScore(fill, state.fillLineFrac, getStreakMultiplier(state.streak));

  // Apply points
  state.score = Math.max(0, state.score + evaluation.points);

  // Update streak: Perfect/Close extend it; anything else resets it
  const prevStreak = state.streak;
  const extended = evaluation.result === 'perfect' || evaluation.result === 'close';
  state.streak = extended ? prevStreak + 1 : 0;
  updateStreakHud(extended && getStreakMultiplier(state.streak) > getStreakMultiplier(prevStreak));

  // Button feedback
  actionBtn.textContent = evaluation.result === 'bust' ? '💥 BUST!' : evaluation.label.split(' ').slice(0, 2).join(' ');
  actionBtn.classList.remove('pouring');
  actionBtn.disabled = true;

  // Update HUD score with bounce
  hudScore.textContent = state.score;
  animateScoreBounce();

  // Show score popup
  showScorePopup(evaluation);

  // Show round result bar
  roundResult.textContent = evaluation.label;
  roundResult.style.color = evaluation.color;
  roundResult.classList.remove('hidden');

  // Visual: if bust, flash the glass red
  if (evaluation.result === 'bust') {
    triggerBustFlash();
  }

  // Progress to next round or game over
  const isLastRound = state.round >= TOTAL_ROUNDS;
  setTimeout(() => {
    if (isLastRound) {
      endGame();
    } else {
      state.round++;
      initRound();
    }
  }, 1800);
}

/* =====================================================================
   SCORE POPUP
   ===================================================================== */
function showScorePopup(evaluation) {
  scorePopup.classList.remove('hidden');
  scorePopup.textContent = evaluation.points > 0 ? `+${evaluation.points}` : String(evaluation.points);
  scorePopup.style.color = evaluation.color;
  scorePopup.style.textShadow = `0 0 20px ${evaluation.color}`;

  // Re-trigger animation by removing and re-adding
  scorePopup.style.animation = 'none';
  void scorePopup.offsetWidth; // force reflow
  scorePopup.style.animation = '';

  setTimeout(() => scorePopup.classList.add('hidden'), 900);
}

/** Refreshes the streak/multiplier HUD; `highlight` pulses it when the multiplier grows. */
function updateStreakHud(highlight) {
  const mult = getStreakMultiplier(state.streak);
  hudStreak.textContent = state.streak > 0
    ? `🔥 ${state.streak} · ${formatMultiplier(mult)}${mult >= MAX_STREAK_MULT ? ' MAX' : ''}`
    : formatMultiplier(mult);
  hudStreak.style.color = state.streak > 0 ? '#ffd700' : '';
  if (highlight) {
    hudStreak.classList.remove('bounce');
    void hudStreak.offsetWidth;
    hudStreak.classList.add('bounce');
    hudStreak.addEventListener('animationend', () => hudStreak.classList.remove('bounce'), { once: true });
  }
}

function animateScoreBounce() {
  const el = hudScore;
  el.classList.remove('bounce');
  void el.offsetWidth;
  el.classList.add('bounce');
  el.addEventListener('animationend', () => el.classList.remove('bounce'), { once: true });
}

/* =====================================================================
   DISTRACTION EFFECTS (Round 5+)
   ===================================================================== */
function scheduleDistraction() {
  const fillDuration = BASE_FILL_DURATION_MS / state.speedMultiplier;
  // Fire at a random point in the middle 50% of the fill
  const delay = fillDuration * (0.25 + Math.random() * 0.5);

  state.distractionTimer = setTimeout(() => {
    if (state.phase !== 'pouring') return;
    const type = Math.floor(Math.random() * 3);
    if (type === 0) triggerFlash();
    else if (type === 1) triggerJitter();
    else triggerButtonFlicker();
  }, delay);
}

function triggerFlash() {
  distractionOverlay.classList.remove('hidden', 'flash');
  void distractionOverlay.offsetWidth;
  distractionOverlay.classList.add('flash');
  distractionOverlay.addEventListener('animationend', () => {
    distractionOverlay.classList.add('hidden');
    distractionOverlay.classList.remove('flash');
  }, { once: true });
}

function triggerJitter() {
  glassWrapper.classList.remove('jitter');
  void glassWrapper.offsetWidth;
  glassWrapper.classList.add('jitter');
  glassWrapper.addEventListener('animationend', () => glassWrapper.classList.remove('jitter'), { once: true });
}

function triggerButtonFlicker() {
  actionBtn.style.opacity = '0.2';
  setTimeout(() => { actionBtn.style.opacity = ''; }, 150);
}

function triggerBustFlash() {
  distractionOverlay.style.background = 'rgba(255,45,85,0.3)';
  distractionOverlay.classList.remove('hidden');
  setTimeout(() => {
    distractionOverlay.classList.add('hidden');
    distractionOverlay.style.background = '';
  }, 250);
}

/* =====================================================================
   GAME START / END
   ===================================================================== */
function startGame() {
  state.round = 1;
  state.score = 0;
  state.streak = 0;
  state.phase = 'idle';
  state.playerName = playerNameInput.value.trim() || 'Anonymous';

  showScreen('game');
  initRound();
}

function endGame() {
  state.phase = 'gameover';

  const finalScore = state.score;
  const prevHighScore = getHighScore();
  const isNewHigh = finalScore > prevHighScore;

  if (isNewHigh) saveHighScore(finalScore);

  // Save to leaderboard
  addLeaderboardEntry(state.playerName, finalScore);

  // Render game over screen
  const titles = [
    [90, '👑 MASTER BARTENDER!', "An absolutely legendary pour. The bar is yours."],
    [60, '🍺 SKILLED BARTENDER', "Impressive reflexes. The regulars approve."],
    [30, '🙂 DECENT POUR', "Not bad! A bit more practice and you'll nail it."],
    [0,  '😅 APPRENTICE', "Everyone starts somewhere. Hit PLAY AGAIN!"],
  ];
  const [, title, subtitle] = titles.find(([min]) => finalScore >= min) || titles[titles.length - 1];
  const emoji = isNewHigh ? '🏆' : finalScore >= 60 ? '🍺' : '🎯';

  gameOverEmoji.textContent = emoji;
  gameOverTitle.textContent = title;
  gameOverSubtitle.textContent = subtitle;
  gameOverScore.textContent = finalScore;
  gameOverHighScore.textContent = Math.max(finalScore, prevHighScore);
  newHighScoreBadge.classList.toggle('hidden', !isNewHigh);

  renderLeaderboard(gameOverLeaderboardList, null);

  showScreen('gameover');
}

function resetToWelcome() {
  state.phase = 'welcome';
  welcomeHighScore.textContent = getHighScore();
  renderLeaderboard(welcomeLeaderboardList, welcomeLeaderboardEmpty);
  showScreen('welcome');
}

/* =====================================================================
   SCREEN MANAGEMENT
   ===================================================================== */
function showScreen(name) {
  welcomeScreen.classList.toggle('hidden', name !== 'welcome');
  gameScreen.classList.toggle('hidden', name !== 'game');
  gameOverScreen.classList.toggle('hidden', name !== 'gameover');
}

/* =====================================================================
   EVENT LISTENERS
   ===================================================================== */
startGameBtn.addEventListener('click', startGame);
playAgainBtn.addEventListener('click', startGame);

actionBtn.addEventListener('click', () => {
  if (state.phase === 'idle')    startPour();
  else if (state.phase === 'pouring') stopPour(false);
});

// Also allow tapping anywhere on the glass area to stop
glassArea.addEventListener('click', (e) => {
  if (state.phase === 'pouring' && e.target !== actionBtn) {
    stopPour(false);
  }
});

// Touch support — prevent double-fire on mobile
actionBtn.addEventListener('touchend', (e) => {
  e.preventDefault();
  if (state.phase === 'idle')    startPour();
  else if (state.phase === 'pouring') stopPour(false);
}, { passive: false });

// Keyboard shortcut: Space bar to start/stop
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat) {
    e.preventDefault();
    if (state.phase === 'idle')    startPour();
    else if (state.phase === 'pouring') stopPour(false);
  }
});

// Allow pressing Enter in the name input to start
playerNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startGame();
});

/* =====================================================================
   INIT
   ===================================================================== */
(function init() {
  welcomeHighScore.textContent = getHighScore();
  renderLeaderboard(welcomeLeaderboardList, welcomeLeaderboardEmpty);
  showScreen('welcome');
})();

