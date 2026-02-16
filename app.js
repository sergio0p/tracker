/**
 * Participation Tracker — iPad Web App
 *
 * Pure JavaScript app for live session tracking on iPad.
 * Reads/writes participation JSON files via Dropbox API.
 * No backend, no build step, no framework.
 *
 * Ports business logic from:
 *   participation/grading_engine.py  (points, name colors)
 *   participation/models.py          (data structures, display names)
 *   participation/data_manager.py    (file paths, save/load)
 *   participation/gui/live_session_view.py (click handlers, grid layout)
 */

// ============================================================
// Configuration — same courses as participation_tracker_qt.py
// ============================================================
const COURSES = [
  {
    course_id: 104159,
    tab_label: '101H',
    course_num: '101',
    file_id: '101H',
    term: 'SPR26',
    sis_section_id: 'ECON101H.001.SP26'
  },
  {
    course_id: 109260,
    tab_label: '510-001',
    course_num: '510',
    file_id: '510001',
    term: 'SPR26',
    sis_section_id: 'ECON510.001.SP26'
  },
  {
    course_id: 109260,
    tab_label: '510-002',
    course_num: '510',
    file_id: '510002',
    term: 'SPR26',
    sis_section_id: 'ECON510.002.SP26'
  }
];

const TIMER_MINUTES = 3;
const SAVE_DEBOUNCE_MS = 500;
const PAST_SESSIONS_TO_SHOW = 3;

// ============================================================
// Application State
// ============================================================
const state = {
  auth: null,
  dbx: null,
  currentCourseIdx: 0,
  courseData: {},          // sis_section_id -> parsed JSON data
  mode: 'present',        // 'present' | 'late' | 'undo'
  photoCache: {},          // 'course_num/student_id' -> blob URL or null
  photoCacheLoading: new Set(),
  saveTimeout: null,
  timerInterval: null,
  saveGeneration: 0,       // tracks pending saves to avoid stale overwrites
};

// ============================================================
// Dropbox File Operations
// ============================================================

/**
 * Get Dropbox path for participation JSON file.
 * Matches data_manager.py:get_course_file (line 36)
 */
function getParticipationPath(course) {
  return `/Teaching/${course.course_num}/Data/${course.file_id}${course.term}participation.json`;
}

/**
 * Get Dropbox path for a student photo.
 * Matches live_session_view.py photo loading pattern.
 */
function getPhotoPath(course, studentId) {
  return `/Teaching/${course.course_num}/Data/roster_photos/${studentId}.jpg`;
}

/**
 * Load course data JSON from Dropbox.
 * Returns parsed object or null if file not found.
 */
async function loadCourseData(course) {
  const path = getParticipationPath(course);
  await state.auth.ensureFreshToken();

  try {
    const response = await state.dbx.filesDownload({ path });
    const blob = response.result.fileBlob;
    const text = await blob.text();
    return JSON.parse(text);
  } catch (err) {
    // Check for file not found
    if (err?.error?.error_summary?.startsWith('path/not_found')) {
      console.warn(`File not found: ${path}`);
      return null;
    }
    throw err;
  }
}

/**
 * Save course data JSON to Dropbox (overwrites existing).
 * Cleans empty sessions before saving (matches data_manager.py:_clean_empty_sessions).
 */
async function saveCourseData(course, data) {
  const path = getParticipationPath(course);
  await state.auth.ensureFreshToken();

  // Clean empty sessions: remove sessions where all records are absent with count 0
  data.sessions = data.sessions.filter(session => {
    const records = Object.values(session.records || {});
    return records.some(r => r.status !== 'absent' || r.count > 0);
  });

  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });

  await state.dbx.filesUpload({
    path: path,
    contents: blob,
    mode: { '.tag': 'overwrite' },
    mute: true
  });
}

/**
 * Load a student photo from Dropbox. Returns blob URL or null.
 * Lazy-loaded and cached.
 */
async function loadPhoto(course, studentId) {
  const cacheKey = `${course.course_num}/${studentId}`;

  if (cacheKey in state.photoCache) return state.photoCache[cacheKey];
  if (state.photoCacheLoading.has(cacheKey)) return null;

  state.photoCacheLoading.add(cacheKey);

  try {
    const path = getPhotoPath(course, studentId);
    await state.auth.ensureFreshToken();
    const response = await state.dbx.filesDownload({ path });
    const blob = response.result.fileBlob;
    const blobUrl = URL.createObjectURL(blob);
    state.photoCache[cacheKey] = blobUrl;
    return blobUrl;
  } catch {
    state.photoCache[cacheKey] = null;
    return null;
  } finally {
    state.photoCacheLoading.delete(cacheKey);
  }
}

// ============================================================
// Business Logic (ported from grading_engine.py + models.py)
// ============================================================

/**
 * Calculate points for a session record.
 * Port of GradingEngine.calculate_session_points (grading_engine.py:44-70)
 */
function calculateSessionPoints(record) {
  if (!record || record.status === 'absent') return 0;
  if (record.status === 'late') return 0.5 + (record.count - 1);
  return record.count; // present
}

/**
 * Format points for cell display.
 */
function formatPoints(record) {
  if (!record || record.status === 'absent') return '0';
  const pts = calculateSessionPoints(record);
  return pts === Math.floor(pts) ? String(pts) : pts.toFixed(1);
}

/**
 * Determine name color based on attendance history.
 * Port of GradingEngine.get_student_name_color (grading_engine.py:214-254)
 */
function getStudentNameColor(studentId, activeSessions) {
  const recent = activeSessions.slice(-3);
  const counts = recent.map(s => {
    const rec = s.records[String(studentId)];
    return rec ? rec.count : 0;
  });

  if (counts.length === 3 && counts[0] === 0 && counts[1] === 0 && counts[2] === 0) {
    return 'name-red';
  }
  if (counts.length > 0 && Math.max(...counts) <= 1) {
    return 'name-magenta';
  }
  return 'name-black';
}

/**
 * Format student display name with row number prefix.
 * Port of Student.get_display_name (models.py:40-57)
 */
function getDisplayName(student, rowNum, totalStudents) {
  const numDigits = String(totalStudents).length;
  const prefix = String(rowNum).padStart(numDigits, '0');
  let name = `${prefix}-${totalStudents} ${student.name}`;
  if (student.note) name += ` (${student.note})`;
  return name;
}

/** Get today's date in YYYY-MM-DD format */
function getToday() {
  return new Date().toISOString().slice(0, 10);
}

/** Format date for column header display: "Mon DD" */
function formatDateDisplay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00'); // noon to avoid timezone issues
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Get or create a record for a student in a session */
function getOrCreateRecord(session, studentId) {
  const key = String(studentId);
  if (!session.records[key]) {
    session.records[key] = { status: 'absent', count: 0 };
  }
  return session.records[key];
}

// ============================================================
// Touch Interaction Handlers
// ============================================================

/**
 * Handle tap on an attendance cell.
 * Ports _increment, _mark_late, _decrement from live_session_view.py:771-835
 */
function handleCellTap(courseData, course, session, studentId) {
  const record = getOrCreateRecord(session, studentId);

  // Set session start_time on first interaction
  if (!session.start_time) {
    session.start_time = new Date().toISOString();
  }

  let effectiveMode = state.mode;

  // 3-minute timer rule: auto-switch present→late after 3 minutes
  // Only for absent students being marked for the first time
  if (effectiveMode === 'present' && session.start_time && record.status === 'absent') {
    const elapsed = (Date.now() - new Date(session.start_time).getTime()) / 1000;
    if (elapsed > TIMER_MINUTES * 60) {
      effectiveMode = 'late';
    }
  }

  switch (effectiveMode) {
    case 'present':
      // Port of _increment (live_session_view.py:771-797)
      if (record.status === 'absent') {
        record.status = 'present';
        record.count = 1;
      } else {
        // Already present or late: just increment count (keep status)
        record.count += 1;
      }
      break;

    case 'late':
      // Port of _mark_late (live_session_view.py:799-818)
      if (record.status === 'absent') {
        record.status = 'late';
        record.count = 1;
      } else {
        // Already marked: switch to late status, keep count
        record.status = 'late';
      }
      break;

    case 'undo':
      // Port of _decrement (live_session_view.py:820-835)
      if (record.count > 1) {
        record.count -= 1;
      } else if (record.count === 1) {
        record.count = 0;
        record.status = 'absent';
      }
      break;
  }

  // Update just the tapped cell (not full re-render)
  updateCellDisplay(studentId, session.date);

  // Update name color (may change after attendance update)
  updateNameColor(studentId, courseData);

  // Update timer bar
  updateTimerBar(session);

  // Debounced auto-save
  scheduleSave(course, courseData);
}

// ============================================================
// Grid Rendering
// ============================================================

/**
 * Render the full grid for the current course.
 * Ports _populate_grid from live_session_view.py.
 */
function renderGrid(courseData, course) {
  if (!courseData) {
    document.getElementById('grid-body').innerHTML =
      '<tr><td colspan="8" style="text-align:center;padding:40px;color:#6e6e73">' +
      'No data file found for this course.</td></tr>';
    return;
  }

  const today = getToday();
  const activeSessions = (courseData.sessions || [])
    .filter(s => s.active)
    .sort((a, b) => a.date.localeCompare(b.date));

  // Past sessions: most recent N active sessions before today
  const pastDates = activeSessions
    .filter(s => s.date < today)
    .map(s => s.date)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, PAST_SESSIONS_TO_SHOW)
    .reverse(); // oldest first

  // Session columns: past dates + today
  const sessionDates = [...pastDates, today];

  // Students sorted alphabetically
  const students = [...(courseData.students || [])].sort(
    (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );

  // Build header
  const thead = document.getElementById('grid-header');
  thead.innerHTML = '';
  const headerRow = document.createElement('tr');

  ['', 'Name', 'Lvl', 'Major'].forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    headerRow.appendChild(th);
  });

  sessionDates.forEach(date => {
    const th = document.createElement('th');
    const isToday = (date === today);
    th.textContent = isToday ? 'TODAY' : formatDateDisplay(date);
    if (isToday) th.classList.add('today-header');
    headerRow.appendChild(th);
  });

  thead.appendChild(headerRow);

  // Build body
  const tbody = document.getElementById('grid-body');
  tbody.innerHTML = '';
  const totalStudents = students.length;

  students.forEach((student, idx) => {
    const row = document.createElement('tr');
    const rowNum = idx + 1;

    // Photo cell
    const photoTd = document.createElement('td');
    photoTd.classList.add('photo-cell');
    const photoKey = `${course.course_num}/${student.id}`;

    if (state.photoCache[photoKey]) {
      const img = document.createElement('img');
      img.src = state.photoCache[photoKey];
      img.alt = student.name;
      img.addEventListener('click', () => showPhotoPopup(student, course));
      photoTd.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.classList.add('photo-placeholder');
      placeholder.textContent = 'Photo';
      placeholder.id = `photo-${student.id}`;
      photoTd.appendChild(placeholder);
      // Lazy-load in background
      loadPhoto(course, student.id).then(url => {
        if (url) {
          const el = document.getElementById(`photo-${student.id}`);
          if (el) {
            const img = document.createElement('img');
            img.src = url;
            img.alt = student.name;
            img.addEventListener('click', () => showPhotoPopup(student, course));
            el.replaceWith(img);
          }
        }
      });
    }
    row.appendChild(photoTd);

    // Name cell
    const nameTd = document.createElement('td');
    nameTd.classList.add('name-cell');
    nameTd.id = `name-${student.id}`;
    const nameColor = getStudentNameColor(student.id, activeSessions);
    nameTd.classList.add(nameColor);
    nameTd.textContent = getDisplayName(student, rowNum, totalStudents);
    row.appendChild(nameTd);

    // Level cell
    const levelTd = document.createElement('td');
    levelTd.classList.add('info-cell');
    levelTd.textContent = student.level || '---';
    row.appendChild(levelTd);

    // Major cell
    const majorTd = document.createElement('td');
    majorTd.classList.add('info-cell', 'major-cell');
    majorTd.textContent = student.major || '---';
    row.appendChild(majorTd);

    // Session cells
    sessionDates.forEach(date => {
      const td = document.createElement('td');
      const isToday = (date === today);
      const session = courseData.sessions.find(s => s.date === date);
      const record = session ? session.records[String(student.id)] : undefined;

      td.id = `cell-${student.id}-${date}`;
      applyAttendanceStyling(td, record);

      if (isToday) {
        td.addEventListener('click', () => {
          // Ensure today's session exists
          let todaySession = courseData.sessions.find(s => s.date === today);
          if (!todaySession) {
            todaySession = {
              date: today,
              start_time: null,
              active: true,
              processed: false,
              records: {}
            };
            courseData.sessions.push(todaySession);
            courseData.sessions.sort((a, b) => a.date.localeCompare(b.date));
          }
          handleCellTap(courseData, course, todaySession, student.id);
        });
      } else {
        td.classList.add('past');
      }

      row.appendChild(td);
    });

    tbody.appendChild(row);
  });

  // Start timer if today's session already has a start_time
  const todaySession = courseData.sessions.find(s => s.date === today);
  if (todaySession && todaySession.start_time) {
    updateTimerBar(todaySession);
    startTimerInterval(todaySession);
  }
}

/** Apply attendance colors and text to a cell */
function applyAttendanceStyling(td, record) {
  td.classList.remove('att-absent', 'att-late', 'att-present');
  td.classList.add('att-cell');

  if (!record || record.status === 'absent') {
    td.classList.add('att-absent');
    td.textContent = '0';
  } else if (record.status === 'late') {
    td.classList.add('att-late');
    td.textContent = formatPoints(record);
  } else {
    td.classList.add('att-present');
    td.textContent = formatPoints(record);
  }
}

/** Update just one cell's display after a tap (no full re-render) */
function updateCellDisplay(studentId, date) {
  const td = document.getElementById(`cell-${studentId}-${date}`);
  if (!td) return;

  const course = COURSES[state.currentCourseIdx];
  const data = state.courseData[course.sis_section_id];
  if (!data) return;

  const session = data.sessions.find(s => s.date === date);
  const record = session ? session.records[String(studentId)] : undefined;
  applyAttendanceStyling(td, record);
}

/** Update a student's name color after attendance change */
function updateNameColor(studentId, courseData) {
  const nameTd = document.getElementById(`name-${studentId}`);
  if (!nameTd) return;

  const activeSessions = (courseData.sessions || [])
    .filter(s => s.active)
    .sort((a, b) => a.date.localeCompare(b.date));

  nameTd.classList.remove('name-red', 'name-magenta', 'name-black');
  nameTd.classList.add(getStudentNameColor(studentId, activeSessions));
}

// ============================================================
// Auto-Save with Debounce
// ============================================================

function scheduleSave(course, courseData) {
  if (state.saveTimeout) clearTimeout(state.saveTimeout);

  state.saveGeneration++;
  const generation = state.saveGeneration;

  state.saveTimeout = setTimeout(async () => {
    // Skip if a newer save is pending
    if (generation !== state.saveGeneration) return;

    try {
      await saveCourseData(course, courseData);
      showToast('Saved', 'success');
    } catch (err) {
      console.error('Save failed:', err);
      showToast('Save failed - retrying...', 'error');
      // Retry once after 2 seconds
      setTimeout(async () => {
        try {
          await saveCourseData(course, courseData);
          showToast('Saved (retry)', 'success');
        } catch (retryErr) {
          console.error('Retry failed:', retryErr);
          showToast('Save failed! Check connection.', 'error');
        }
      }, 2000);
    }
  }, SAVE_DEBOUNCE_MS);
}

// ============================================================
// Toast Notifications
// ============================================================

function showToast(message, type) {
  // Remove existing toast
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

// ============================================================
// 3-Minute Timer
// ============================================================

function updateTimerBar(session) {
  const bar = document.getElementById('timer-bar');
  if (!session || !session.start_time) {
    bar.style.background = 'transparent';
    return;
  }

  const elapsed = (Date.now() - new Date(session.start_time).getTime()) / 1000;
  const thresholdSec = TIMER_MINUTES * 60;

  if (elapsed <= thresholdSec) {
    const pct = Math.min(100, (elapsed / thresholdSec) * 100);
    bar.style.background = `linear-gradient(to right, #34c759 ${pct}%, #e5e5e5 ${pct}%)`;
  } else {
    bar.style.background = '#ff9f0a';
  }
}

function startTimerInterval(session) {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = setInterval(() => updateTimerBar(session), 1000);
}

// ============================================================
// Photo Popup
// ============================================================

function showPhotoPopup(student, course) {
  const photoKey = `${course.course_num}/${student.id}`;
  const photoUrl = state.photoCache[photoKey];
  if (!photoUrl) return;

  const popup = document.getElementById('photo-popup');
  const img = document.getElementById('photo-popup-img');
  const name = document.getElementById('photo-popup-name');

  img.src = photoUrl;
  name.textContent = student.name;
  popup.style.display = 'flex';

  // Close on tap anywhere
  let autoCloseTimer;
  const close = () => {
    popup.style.display = 'none';
    popup.removeEventListener('click', close);
    if (autoCloseTimer) clearTimeout(autoCloseTimer);
  };
  popup.addEventListener('click', close);

  // Auto-close after 8 seconds
  autoCloseTimer = setTimeout(close, 8000);
}

// ============================================================
// Mode Toggle
// ============================================================

function initModeToggle() {
  const buttons = document.querySelectorAll('.mode-btn');
  buttons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.mode = btn.dataset.mode;
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

// ============================================================
// Course Tab Switching
// ============================================================

function initCourseTabs() {
  const tabContainer = document.getElementById('course-tabs');
  tabContainer.innerHTML = '';

  COURSES.forEach((course, idx) => {
    const tab = document.createElement('button');
    tab.classList.add('course-tab');
    if (idx === 0) tab.classList.add('active');
    tab.textContent = course.tab_label;
    tab.addEventListener('click', () => switchCourse(idx));
    tabContainer.appendChild(tab);
  });
}

async function switchCourse(idx) {
  state.currentCourseIdx = idx;

  // Update tab highlighting
  document.querySelectorAll('.course-tab').forEach((tab, i) => {
    tab.classList.toggle('active', i === idx);
  });

  // Stop existing timer
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }

  // Reset timer bar
  document.getElementById('timer-bar').style.background = 'transparent';

  const course = COURSES[idx];

  // Load if not cached
  if (!state.courseData[course.sis_section_id]) {
    document.getElementById('loading').style.display = 'flex';
    document.getElementById('grid-container').style.display = 'none';

    try {
      const data = await loadCourseData(course);
      state.courseData[course.sis_section_id] = data;
    } catch (err) {
      console.error('Failed to load course:', err);
      showToast('Failed to load course data', 'error');
    }

    document.getElementById('loading').style.display = 'none';
    document.getElementById('grid-container').style.display = '';
  }

  renderGrid(state.courseData[course.sis_section_id], course);
}

// ============================================================
// App Initialization
// ============================================================

async function initApp() {
  // Step 1: Authenticate with Dropbox
  state.auth = new DropboxAuth();
  const authenticated = await state.auth.init();

  if (!authenticated) {
    document.getElementById('auth-screen').style.display = 'flex';
    document.getElementById('auth-btn').addEventListener('click', () => {
      document.getElementById('auth-status').textContent = 'Redirecting to Dropbox...';
      state.auth.startAuth();
    });
    return;
  }

  state.dbx = state.auth.getClient();

  // Step 2: Show app
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';

  // Step 3: Initialize UI
  initCourseTabs();
  initModeToggle();

  // Step 4: Load first course
  await switchCourse(0);
}

// Start when DOM is ready
document.addEventListener('DOMContentLoaded', initApp);
