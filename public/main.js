const TelegramBot = require('node-telegram-bot-api');

const token = '';


const bot = new TelegramBot(token, { polling: true });


// ФАЙЛ-БАЗА ДАННЫХ ГРУПП
// Используем fs для синхронных операций (writeFileSync/readFileSync)
const fs = require('fs');
// const lastPostByChat = {};

const SUPPORT_BOT_URL = 'https://t.me/ranepa_support_bot';
const DORM_URL = 'https://siu.ranepa.ru/obshchezhitiya/';
const SITE_SIU_URL = 'https://siu.ranepa.ru/';
const STUDENT_PAGE_URL = 'https://siu.ranepa.ru/studentam/';
const SCHEDULE_URL = 'https://siu.ranepa.ru/raspisanie';
const RANEPA_PORTAL_URL = 'https://ranepa.ru/';
const MAP_URL = 'http://45.8.158.242/navigation/';

const path = require('path');
const { distance } = require('fastest-levenshtein');

// --- Пути к файлам БД ---
const EVENTS_PATH = path.join(__dirname, 'bdshka/event.json');
const DATA_PATH = path.join(__dirname, 'bdshka/bazary.json');
const EP_PATH = path.join(__dirname, 'bdshka/EP.json');

function saveGroups() {
  // Сохраняем группы вместе с телефонами в bazary.json, т.к. отдельного пути к группам нет
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify({ users: usersDb.users || {}, groups: groupsDb.groups || {}, roles: usersDb.roles || { byChatId: {}, byUsername: {} } }, null, 2), 'utf8');
  } catch (e) {
    console.error('Ошибка записи БД групп:', e);
  }
}

// --- Чтение / запись ролей ---
function readDb() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.users) parsed.users = {};
    if (!parsed.groups) parsed.groups = {};
    if (!parsed.roles || typeof parsed.roles !== 'object') parsed.roles = { byChatId: {}, byUsername: {} };
    if (!parsed.roles.byChatId) parsed.roles.byChatId = {};
    if (!parsed.roles.byUsername) parsed.roles.byUsername = {};
    return parsed;
  } catch (e) {
    return { users: {}, groups: {}, roles: { byChatId: {}, byUsername: {} } };
  }
}
let db = readDb();
let usersDb = db;
let groupsDb = db;
let EP = {};
let lastCalendarMsgByChat = {}; // chatId => messageId

try {
  EP = JSON.parse(fs.readFileSync(EP_PATH, 'utf8'));
} catch (e) {
  console.error("Ошибка загрузки EP.json:", e);
  EP = { programs: {} };
}

// --- Чтение / запись мероприятий ---
function readEvents() {
  try {
    const raw = fs.readFileSync(EVENTS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { events: {} };
  }
}
let eventsDb = readEvents();

const FAQ_PATH = path.join(__dirname, 'bdshka/FAQ.json');
let FAQ = {};

try {
  FAQ = JSON.parse(fs.readFileSync(FAQ_PATH, 'utf8'));
} catch (e) {
  console.error("Ошибка загрузки FAQ.json:", e);
  FAQ = {};
}

function saveEvents() {
  try {
    fs.writeFileSync(EVENTS_PATH, JSON.stringify(eventsDb, null, 2), 'utf8');
  } catch (e) {
    console.error('Ошибка записи БД событий:', e);
  }
}

// --- Сохранение базы пользователей и групп ---
function saveDb() {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify({ users: usersDb.users || {}, groups: groupsDb.groups || {}, roles: usersDb.roles || { byChatId: {}, byUsername: {} } }, null, 2), 'utf8');
  } catch (e) {
    console.error('Ошибка записи БД пользователей/групп:', e);
  }
}

// номера телефонов больше не используются

const userProfiles = new Map();

function getUserProfile(chatId) {
  if (!userProfiles.has(chatId)) {
    let initial = {};
    try {
      const users = usersDb.users || {};
      const key = Object.keys(users).find(k => String(users[k].chatId) === String(chatId));
      if (key) {
        const u = users[key] || {};
        initial = {
          firstName: u.firstName || '',
          lastName: u.lastName || '',
          username: u.username || '',
          group: u.group || ''
        };
      }
    } catch (_) {}
    userProfiles.set(chatId, initial);
  }
  return userProfiles.get(chatId);
}

function updateUserProfile(chatId, data = {}) {
  const current = getUserProfile(chatId);
  Object.assign(current, data);
}

function getEffectiveRole(chatId) {
  const profile = getUserProfile(chatId);
  return profile.currentRole || getUserRolePhone(chatId);
}

// проверка, является ли пользователь администратором
function userIsAdmin(chatId) {
  return getEffectiveRole(chatId) === ROLES.ADMIN;
}

function getUserRolePhone(chatId) {
  const profile = getUserProfile(chatId);
  const rid = String(chatId);
  const unameLower = (profile.username || '').toLowerCase();
  const raw = (usersDb.roles && usersDb.roles.byChatId && usersDb.roles.byChatId[rid])
    || (unameLower && usersDb.roles && usersDb.roles.byUsername && usersDb.roles.byUsername[unameLower])
    || (profile.role || null);
  if (raw) {
    const roleMap = { admin: ROLES.ADMIN, teacher: ROLES.TEACHER, student: ROLES.STUDENT, employee: ROLES.EMPLOYEE, guest: ROLES.GUEST };
    return roleMap[raw] || ROLES.GUEST;
  }
  return ROLES.GUEST;
}

// фунцкия для проверки доступа по номеру
function hasAccess(chatId, requiredRole) {
  const userRole = getEffectiveRole(chatId);
  if (userRole === ROLES.ADMIN) return true;
  return userRole === requiredRole;
}



// --- Роли ---
const ROLES = {
  STUDENT: 'student',
  TEACHER: 'teacher',
  
  EMPLOYEE: 'employee',
  ADMIN: 'admin',
  GUEST: 'guest'
};

// Названия ролей
const roleNames = {
  [ROLES.TEACHER]: 'преподаватель',
  [ROLES.STUDENT]: 'студент',
  [ROLES.ADMIN]: 'администратор',
  [ROLES.EMPLOYEE]: 'сотрудник',
  
  [ROLES.GUEST]: 'гость'
};

// Состояния пользователей
const userStates = {};

function setUserState(chatId, state, data = {}) {
  userStates[chatId] = { state, data };
}

function getUserState(chatId) {
  return userStates[chatId] || { state: null, data: {} };
}

function clearUserState(chatId) {
  delete userStates[chatId];
}

// --- Установка команд ---
// const botCommands = [
//   { command: '/start', description: 'Запустить или перезапустить бота' },
// ];

// bot.setMyCommands(botCommands)
//   .then(() => console.log('Команды бота установлены успешно'))
//   .catch((error) => console.log('Ошибка установки команд:', error));

// Меню гостя
function getGuestMenu() {
  return {
    keyboard: [
      [{ text: 'Навигация' }],
      [{ text: 'Я абитуриент' }, { text: 'Я участник мероприятия' }],
      [{ text: 'Техническая поддержка' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function getStudentMenu() {
  return {
    keyboard: [
      [{ text: 'Навигация' }],
      [{ text: 'Я поступил' }, { text: 'Я участник мероприятия' }],
      [{ text: 'Расписание' }, { text: 'Оценки' }],
      [{ text: 'Полезные ссылки'}],
      [{ text: 'Техническая поддержка' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function getTeacherMenu() {
  return {
    keyboard: [
      [{ text: 'Навигация' }],
      [{ text: 'Оповестить студентов'}],
      [{ text: 'Расписание' }, { text: 'Журнал' }],
      [{ text: 'Техническая поддержка' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function getEmployeeMenu() {
  return {
    keyboard: [
      [{ text: 'Навигация' }],
      [{ text: 'Документы HR' }],
      [{ text: 'Служебные заявки'}],
      [{ text: 'Техническая поддержка' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function getApplicantMenu() {
  return {
    keyboard: [
      [{ text: 'Навигация' }],
      [{ text: 'Образовательные программы' }],
      [{ text: 'Назад'}]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function getNavigationMenu() {
  return {
    keyboard: [
      [{ text: 'Найти аудиторию' }],
      [{ text: 'Техническая поддержка' }],
      [{ text: 'Назад'}]
      ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function getIncomingMenu(){
  return {
    keyboard: [
      [{ text: 'Навигация' }],
      [{ text: 'Наставник - кто это?' }], [{text: 'Календарь первокурсника' }],
      [{ text: 'Найти свою группу' }],
      [{ text: 'Общежитие' }],  
      [{ text: 'Назад'}]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  }
}

function getAdminMenu() {
  return {
    keyboard: [
      [{ text: 'Модерация' }],
      [{ text: 'Навигация' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

// удалено меню техподдержки

function getEPMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Лицей', callback_data: 'Лицей' }, { text: 'Колледж', callback_data: 'Колледж' }],
        [{ text: 'Бакалавриат', callback_data: 'Бакалавриат' }, { text: 'Специалитет', callback_data: 'Специалитет' }],
        [{ text: 'Магистратура', callback_data: 'Магистратура' }, { text: 'Аспирантура', callback_data: 'Аспирантура' }],
        [{ text: 'В меню', callback_data: 'BACK_TO_MENU' }]
      ]
    }
  };
}

function getEventMenu() {
  return {
    keyboard: [
      [{ text: 'Навигация' }],
      [{ text: 'Все мероприятия' }],
      [{ text: 'Назад' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function getMenuBroadcast() {
  return {
    keyboard: [
      [{ text: 'Оповестить группу'}],
      [{ text: 'Оповестить все группы'}],
      [{ text: 'Назад' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function getMenuSchedule() {
  return {
    keyboard: [
      [{ text: 'Расписание группы' }],
      [{ text: 'Расписание преподавателя' }],
      [{ text: 'Назад' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

// bot.onText(/\/uploadcircle/, async (msg) => {
//   const chatId = msg.chat.id;

//   try {
//     const sent = await bot.sendVideoNote(
//       chatId,
//       'C:/all/tourism-blyat/ranepabot/image/circle_ready2.mp4', // ✅ НОВЫЙ файл
//       {
//         // length: 720,            // ✅ диаметр кружка (совпадает с размером видео)
//         contentType: 'video/mp4'
//       }
//     );
  
//     if (sent.video_note) {
//       console.log('BOT video_note file_id =', sent.video_note.file_id);
//       await bot.sendMessage(chatId, `file_id (video_note): ${sent.video_note.file_id}`);
//     } else if (sent.video) {
//       console.log('Ушло как обычное видео, file_id =', sent.video.file_id);
//       await bot.sendMessage(chatId, `⚠️ Ушло как обычное видео. file_id: ${sent.video.file_id}`);
//     }
//   } catch (e) {
//     console.error('sendVideoNote error:', e?.response?.body || e.message);
//   }
// });



const VIDEO_NOTE_START_ID = 'DQACAgIAAxkDAAIyoWkrE9rTCJsnl2j1gT2mYwElxTGAAAJ2lAACiZdZSXO-03zxp98yNgQ';
const VIDEO_NOTE_INCOMING_ID = 'DQACAgIAAxkDAAIysWkrHbKvMqK9-fdJHqdnJbFS6_AfAAIOlQACiZdZSa2lL1evI_uZNgQ';
const VIDEO_NOTE_NAVIGATION_ID = 'DQACAgIAAxkDAAIytGkrHm225ne7QNDviteNf4MkluU7AAIYlQACiZdZSSidjlBiRecENgQ';
const VIDEO_NOTE_HULI_ID = 'DQACAgIAAxkDAAI2KGkskQhjtztinZxnf9xTGAodsHGfAAJpjAACoFhpSRz0iajZwuFqNgQ';

// --- Команды /start, /menu, /role, /myid и вывод кружка при /start---
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const m = await bot.sendVideoNote(chatId, VIDEO_NOTE_HULI_ID);
    if (m && m.video_note){
      console.log('start video_note OK for', chatId, m.video_note.file_id);
    }
  } catch (e) {
    console.error('start video_note FAIL for', chatId, 
      e?.response?.body || e.message );
  }
  if (msg.chat && msg.chat.type !== 'private') return;
  const profile = getUserProfile(chatId);

  const role = getEffectiveRole(chatId);
  if (!profile.currentRole) updateUserProfile(chatId, { currentRole: role || ROLES.GUEST });

  const from = msg.from || {};
  const fromFirst = from.first_name || '';
  const fromLast = from.last_name || '';
  const fromUsername = from.username || '';
  let first = profile.firstName || '';
  let last = profile.lastName || '';
  let username = profile.username || '';
  try {
    const users = usersDb.users || {};
    const byCidKey = Object.keys(users).find(k => String(users[k].chatId) === String(chatId));
    const byCid = byCidKey ? users[byCidKey] : null;
    let byUname = null;
    const unameForLookup = (fromUsername || username || '').toLowerCase();
    if (!byCid && unameForLookup) {
      byUname = Object.values(users).find(u => String(u.username || '').toLowerCase() === unameForLookup) || null;
    }
    const rec = byCid || byUname;
    if (rec) {
      first = rec.firstName || fromFirst || first;
      last = rec.lastName || fromLast || last;
      username = rec.username || fromUsername || username;
    } else {
      first = first || fromFirst;
      last = last || fromLast;
      username = username || fromUsername;
    }
  } catch (_) {}
  updateUserProfile(chatId, { firstName: first, lastName: last, username });
  const isTeacherEmployee = (role === ROLES.TEACHER || role === ROLES.EMPLOYEE);
  let displayName = '';
  if (isTeacherEmployee) {
    const users = usersDb.users || {};
    const byCidKey = Object.keys(users).find(k => String(users[k].chatId) === String(chatId));
    const byCid = byCidKey ? users[byCidKey] : null;
    const unameForLookup = (username || '').toLowerCase();
    const byUname = (!byCid && unameForLookup) ? (Object.values(users).find(u => String(u.username || '').toLowerCase() === unameForLookup) || null) : null;
    const rec = byCid || byUname;
    if (rec && (rec.firstName || rec.lastName)) {
      displayName = [rec.firstName || '', rec.lastName || ''].filter(Boolean).join(' ').trim();
    } else if (first || last) {
      displayName = [first || '', last || ''].filter(Boolean).join(' ').trim();
    } else {
      displayName = (username ? '@' + username : 'пользователь');
    }
  } else {
    displayName = (first || (username ? '@' + username : 'пользователь'));
  }

  const roleDisplay = roleNames[getEffectiveRole(chatId)] || 'пользователя';
  if (role === ROLES.TEACHER || role === ROLES.EMPLOYEE) {
    bot.sendMessage(chatId, `Здравствуйте, ${displayName}, вы ${roleDisplay}.`, { reply_markup: getMenuByRole(chatId) });
  } else {
    bot.sendMessage(chatId, `Привет, ${displayName}, вы ${roleDisplay}.`, { reply_markup: getMenuByRole(chatId) });
  }
});

bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat && msg.chat.type !== 'private') return;
  const userRole = getEffectiveRole(chatId);
  
  const menuTitles = {
    [ROLES.GUEST]: 'гостя',
    [ROLES.STUDENT]: 'студента',
    [ROLES.TEACHER]: 'преподавателя',
    [ROLES.EMPLOYEE]: 'сотрудника',
    [ROLES.ADMIN]: 'администратора',
  };

  const menuTitle = menuTitles[userRole] || 'Главное меню';

  bot.sendMessage(chatId, `Меню ${menuTitle}:`, {
    reply_markup: getMenuByRole(chatId)
  });
});

// удалена команда /support

bot.onText(/^\/bind_group$/, async (msg) => {
  if (msg.chat && msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;

  if(!userIsAdmin(chatId)) {
    return bot.sendMessage(chatId, 'У вас недостаточно прав для этой команды.')
  }

  await bot.sendMessage(chatId, 'Использование: /bind_group <ГРУППА> <chatId|@username>');
});

// Привязка текущего группового чата к учебной группе
bot.onText(/\/bind_group\s+(.+)/, async (msg, match) => {
  if (msg.chat && msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;

  if (!userIsAdmin(chatId)) {
    return bot.sendMessage(chatId, 'У вас недостаточно прав для этой команды.')
  }

  const args = match[1].trim().split(/\s+/);
  if (args.length < 2) {
    await bot.sendMessage(chatId, 'Использование: /bind_group <ГРУППА> <chatId|@username>');
    return;
  }

  const groupName = args[0];
  const target = args[1];
  groupsDb.groups = groupsDb.groups || {};
  const existing = groupsDb.groups[groupName] || {};
  if (target.startsWith('@')) {
    groupsDb.groups[groupName] = { ...existing, chatUsername: target };
  } else {
    const numericId = Number(target);
    if (!Number.isFinite(numericId)) {
      bot.sendMessage(chatId, 'Некорректный chatId. Укажите число (например -100...) или используйте @username.');
      return;
    }
    groupsDb.groups[groupName] = { ...existing, chatId: numericId };
  }
  saveDb();
  bot.sendMessage(chatId, `Привязка выполнена: группа ${groupName} → ${target}.`);
});

// удалены категории техподдержки


function capitalizeFirst(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Показываем администратору список открытых заявок
// удалён список заявок техподдержки


// Функция для получения меню в зависимости от роли (с учётом выбранного режима)
function getMenuByRole(chatId) {
  const userRole = getEffectiveRole(chatId);
  switch (userRole) {
    case ROLES.STUDENT:
      return getStudentMenu();
    case ROLES.TEACHER:
      return getTeacherMenu();
    // case ROLES.APPLICANT:
    //   return getApplicantMenu();
    case ROLES.EMPLOYEE:
      return getEmployeeMenu();
    case ROLES.ADMIN:
      return getAdminMenu();
    default:
      return getGuestMenu();
  }
}

async function showGroupPrompt(chatId, text = 'Введите вашу группу (например, 24140КИСП):') {
  try {
    const prevP = lastGroupPromptsByChat[chatId] || [];
    for (const id of prevP.slice(-2)) { await safeDelete(chatId, id); }
    const prevS = lastGroupSuggestByChat[chatId] || [];
    for (const id of prevS.slice(-2)) { await safeDelete(chatId, id); }
  } catch (_) {}
  try {
    const rm = await bot.sendMessage(chatId, '.', { reply_markup: { remove_keyboard: true } });
    await safeDelete(chatId, rm.message_id);
  } catch (_) {}
  const m = await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: 'В меню', callback_data: 'BACK_TO_MENU' }]] } });
  lastGroupPromptsByChat[chatId] = [m.message_id];
}

async function showTeacherPrompt(chatId) {
  try {
    const prevP = lastTeacherPromptsByChat[chatId] || [];
    for (const id of prevP.slice(-2)) { await safeDelete(chatId, id); }
    const prevS = lastTeacherSuggestByChat[chatId] || [];
    for (const id of prevS.slice(-2)) { await safeDelete(chatId, id); }
  } catch (_) {}
  const m = await bot.sendMessage(chatId, 'Введите ФИО или фамилию преподавателя:', { reply_markup: { remove_keyboard: true } });
  lastTeacherPromptsByChat[chatId] = [m.message_id];
}

function getCalendarMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Сентябрь', callback_data: 'CAL_09' },
          { text: 'Октябрь', callback_data: 'CAL_10' }
        ],
        [
          { text: 'Ноябрь', callback_data: 'CAL_11' },
          { text: 'Декабрь', callback_data: 'CAL_12' }
        ],
        [
          { text: 'Январь', callback_data: 'CAL_01' },
          { text: 'Февраль', callback_data: 'CAL_02' }
        ],
        [
          { text: 'Март', callback_data: 'CAL_03' },
          { text: 'Апрель', callback_data: 'CAL_04' }
        ],
        [
          { text: 'Май', callback_data: 'CAL_05' },
          { text: 'Июнь', callback_data: 'CAL_06' }
        ],
        [
          { text: 'Назад', callback_data: 'CAL_BACK' },
          { text: 'В меню', callback_data: 'BACK_TO_MENU' }
        ]
      ]
    }
  };
}


function formatEventCard(event) {
  return `
<b>${event.title}</b>

🗓 Дата: <b>${event.date || "не указана"}</b>
⏰ Время: <b>${event.time || "не указано"}</b>
📍 Место: <b>${event.location || "не указано"}</b>

📘 Описание:
${event.description || "Описание отсутствует"}

`;
}

function formatEPCard(ep) {
    return `
      <b>${ep.title}</b>

      📘 <b>Кратко:</b> ${ep.short}

      📚 <b>Описание:</b>
      ${ep.description}

      🎓 <b>Профили:</b>
      - ${ep.profiles.join('\n- ')}

      ⏳ <b>Срок обучения:</b> ${ep.duration}
      🏫 <b>Форма обучения:</b> ${ep.form}

      🔗 <a href="${ep.link}">Подробнее на сайте</a>
  `;
}

// function formatMentorCard(mentorInfo) {
//   return `
// ${mentorInfo.about}
// `;
// }


function findEvent(input) {
  const normalized = (input || '').toUpperCase().trim();
  const eventNames = Object.keys(eventsDb.events || {});

  // Точное совпадение
  const exact = eventNames.find(ev => ev.toUpperCase() === normalized);
  if (exact) {
    return { match: exact, suggestions: [] };
  }

  // Частичное совпадение
  const partial = eventNames.filter(ev => ev.toUpperCase().includes(normalized));
  if (partial.length > 0) return { match: null, suggestions: partial };

  // Левенштейн
  const scored = eventNames.map(name => ({
    name,
    score: distance(normalized, name.toUpperCase())
  })).sort((a, b) => a.score - b.score);

  const threshold = Math.max(3, Math.floor(normalized.length / 2));
  const close = scored.filter(s => s.score <= threshold).map(s => s.name);

  return { match: null, suggestions: close };
}

// --- Вспомогательные функции для расписания / оценок ---
function getSchedule(groupName) {
  const group = groupsDb.groups[groupName];
  return group ? group.schedule : null;
}

function getDaySelectMenu() {
  return {
    inline_keyboard: [
      [
        { text: 'Понедельник', callback_data: 'TEACHER_DAY:Понедельник' },
        { text: 'Вторник', callback_data: 'TEACHER_DAY:Вторник' }
      ],
      [
        { text: 'Среда', callback_data: 'TEACHER_DAY:Среда' },
        { text: 'Четверг', callback_data: 'TEACHER_DAY:Четверг' }
      ],
      [
        { text: 'Пятница', callback_data: 'TEACHER_DAY:Пятница' },
        { text: 'Суббота', callback_data: 'TEACHER_DAY:Суббота' }
      ],
      [ { text: 'В меню', callback_data: 'BACK_TO_MENU' } ]
    ]
  };
}

function extractDaySchedule(scheduleText, dayName) {
  try {
    const days = ['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'];
    const idx = scheduleText.indexOf(dayName);
    if (idx === -1) return null;
    const nextDayIdx = days
      .filter(d => d !== dayName)
      .map(d => ({ d, i: scheduleText.indexOf(d, idx + dayName.length) }))
      .filter(x => x.i !== -1)
      .map(x => x.i)
      .sort((a,b) => a-b)[0];
    const end = typeof nextDayIdx === 'number' ? nextDayIdx : scheduleText.length;
    const chunk = scheduleText.slice(idx, end).trim();
    return chunk || null;
  } catch (_) {
    return null;
  }
}


// --- Состояние: ввод названия мероприятия ---
const awaitingEventName = {}; // chatId => true

 

// техподдержка вынесена в отдельного бота
const lastGroupPromptsByChat = {}; // chatId => message_id[]
const lastGroupSuggestByChat = {}; // chatId => message_id[]
const lastTeacherPromptsByChat = {}; // chatId => message_id[]
const lastTeacherSuggestByChat = {}; // chatId => message_id[]
const lastModerationPromptByChat = {}; // chatId => message_id
const lastModerationListByChat = {}; // chatId => message_id

function normalizeUsersDb() {
  try {
    usersDb.users = usersDb.users || {};
    const entries = usersDb.users;
    const byUsername = {};
    for (const [key, val] of Object.entries(entries)) {
      const uname = (val && val.username) ? String(val.username).trim() : '';
      if (!uname) continue;
      (byUsername[uname] = byUsername[uname] || []).push({ key, val });
    }
    for (const uname of Object.keys(byUsername)) {
      const list = byUsername[uname];
      if (list.length < 2) continue;
      const score = (obj) => {
        const v = obj.val || {};
        let s = 0;
        for (const k of Object.keys(v)) { if (v[k] !== undefined && v[k] !== null && v[k] !== '') s++; }
        if (v.chatId) s += 10;
        return s;
      };
      list.sort((a,b)=>score(b)-score(a));
      const primary = list[0];
      const merged = { ...primary.val };
      for (let i=1;i<list.length;i++) {
        const v = list[i].val;
        for (const k of Object.keys(v)) {
          if (merged[k] === undefined || merged[k] === null || merged[k] === '') merged[k] = v[k];
        }
      }
      usersDb.users[primary.key] = merged;
      for (let i=1;i<list.length;i++) {
        delete usersDb.users[list[i].key];
      }
    }
    for (const [key, val] of Object.entries(entries)) {
      const hasChat = !!(val && val.chatId);
      const fields = Object.keys(val || {});
      const meaningful = fields.filter(k => !['username'].includes(k) && val[k] !== undefined && val[k] !== null && val[k] !== '').length;
      if (!hasChat && fields.length > 0 && meaningful === 0) {
        delete usersDb.users[key];
      }
    }
    saveDb && saveDb();
  } catch (_) {}
}
// Храним выбранную категорию фильтра для каждого администратора
 

// Форматирование даты на русский лад
function formatDateRu(isoString) {
  const date = new Date(isoString);
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const day = date.getDate();
  const monthName = months[date.getMonth()];
  const year = date.getFullYear();
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${day} ${monthName} ${year} года, ${hours}:${minutes}`;
}



// --- Обработчик сообщений (главный) ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const chatType = msg.chat && msg.chat.type;
  const from = msg.from || {};
  updateUserProfile(chatId, {
    username: from.username || getUserProfile(chatId).username,
  });

  if (chatType && chatType !== 'private') return;

  await safeDelete(chatId, lastIncCircleByChat[chatId]);
  delete lastIncCircleByChat[chatId];

  if (text === 'Все мероприятия') {
      const eventNames = Object.keys(eventsDb.events);

      if (eventNames.length === 0) {
        await bot.sendMessage(chatId, 'Список мероприятий пуст.', {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'В меню', callback_data: 'BACK_TO_MENU' }]
            ]
          }
        });
      } else {
        const eventButtons = eventNames.map(eventName => [
          { text: eventName, callback_data: 'event_' + eventName }
        ]);

        eventButtons.push([{ text: 'В меню', callback_data: 'BACK_TO_MENU' }]);

        const listMsg = await bot.sendMessage(chatId, 'Выберите мероприятие:', {
          reply_markup: {
            inline_keyboard: eventButtons
          }
        });
        lastSelectPromptByChat[chatId] = listMsg.message_id;
        lastSelectListByChat[chatId] = listMsg.message_id;
      }
      return;
    }

  if (text === 'Написать в поддержку') {
    bot.sendMessage(chatId, 'Откройте бота техподдержки', {
      reply_markup: { inline_keyboard: [[{ text: 'Перейти в бота', url: SUPPORT_BOT_URL }], [{ text: 'В меню', callback_data: 'BACK_TO_MENU' }]] }
    });
    return;
  }

  

  

  // сбор контактов отключен

  if (!text) return; // Если текста нет, выходим, чтобы не попасть в default

  // Обработка админ-команд в приватном чате (fallback, если onText не сработал)
  if (text.startsWith('/')) {
    if (text === '/set_role') {
      if (!userIsAdmin(chatId)) return;
      const roles = ['student','teacher','admin','employee','guest'];
      const buttons = roles.map(r => [{ text: r, callback_data: `admin_set_role:${r}` }]);
      bot.sendMessage(chatId, 'Укажите роль или используйте: /set_role <роль>', { reply_markup: { inline_keyboard: buttons } });
      return;
    }
    if (text.startsWith('/set_role ')) {
      if (!userIsAdmin(chatId)) return;
      const roleRaw = text.split(/\s+/)[1]?.toLowerCase();
      const allowed = ['student','teacher','admin','employee','guest'];
      if (!allowed.includes(roleRaw)) {
        bot.sendMessage(chatId, 'Роль некорректна. Доступно: student, teacher, admin, employee, guest');
        return;
      }
      const roleMap = { student: ROLES.STUDENT, teacher: ROLES.TEACHER, admin: ROLES.ADMIN, employee: ROLES.EMPLOYEE, guest: ROLES.GUEST };
      updateUserProfile(chatId, { currentRole: roleMap[roleRaw], role: roleRaw });
      const username = msg.from && msg.from.username;
      usersDb.roles = usersDb.roles || { byChatId: {}, byUsername: {} };
      usersDb.roles.byChatId[String(chatId)] = roleRaw;
      if (username) usersDb.roles.byUsername[String(username).toLowerCase()] = roleRaw;
      saveDb();
      normalizeUsersDb();
      bot.sendMessage(chatId, `Роль установлена: ${roleRaw}.`, { reply_markup: getMenuByRole(chatId) });
      return;
    }
    if (text === '/set_role_for') {
      if (!userIsAdmin(chatId)) return;
      const roles = ['student','teacher','admin','employee','guest'];
      const buttons = roles.map(r => [{ text: r, callback_data: `admin_set_role_for:${r}` }]);
      bot.sendMessage(chatId, 'Выберите роль, затем отправьте @username или chatId пользователя.', { reply_markup: { inline_keyboard: buttons } });
      return;
    }
    if (text.startsWith('/set_role_for ')) {
      if (!userIsAdmin(chatId)) return;
      const [, targetRef, roleRawInput] = text.split(/\s+/);
      const roleRaw = (roleRawInput || '').toLowerCase();
      const allowed = ['student','teacher','admin','employee','guest'];
      if (!allowed.includes(roleRaw) || !targetRef) {
        bot.sendMessage(chatId, 'Использование: /set_role_for <@username|chatId> <роль>');
        return;
      }
      const roleMap = { student: ROLES.STUDENT, teacher: ROLES.TEACHER, admin: ROLES.ADMIN, employee: ROLES.EMPLOYEE, guest: ROLES.GUEST };
      usersDb.users = usersDb.users || {};
      usersDb.roles = usersDb.roles || { byChatId: {}, byUsername: {} };
      let targetChatId = null;
      if (targetRef.startsWith('@')) {
        const uname = targetRef.slice(1);
        const unameLower = uname.toLowerCase();
        let key = Object.keys(usersDb.users).find(k => (usersDb.users[k].username || '') === uname);
        usersDb.roles.byUsername[unameLower] = roleRaw;
        const foundCidKey = Object.keys(usersDb.users).find(k => String(usersDb.users[k].chatId) === String(chatId));
        targetChatId = foundCidKey ? usersDb.users[foundCidKey].chatId || null : null;
      } else {
        const numericId = Number(targetRef);
        if (!Number.isFinite(numericId)) {
          bot.sendMessage(chatId, 'Некорректный идентификатор. Укажите @username или числовой chatId.');
          return;
        }
        let key = Object.keys(usersDb.users).find(k => String(usersDb.users[k].chatId) === String(numericId));
        const existing = key ? usersDb.users[key] : { chatId: numericId };
        usersDb.users[key || String(numericId)] = existing;
        usersDb.roles.byChatId[String(numericId)] = roleRaw;
        targetChatId = numericId;
      }
      saveDb();
      normalizeUsersDb();
      if (targetChatId) updateUserProfile(targetChatId, { currentRole: roleMap[roleRaw], role: roleRaw });
      bot.sendMessage(chatId, `Роль пользователя ${targetRef} установлена: ${roleRaw}.`);
      return;
    }
    return; // другие команды не обрабатываем здесь
  }

  

  // --- Обработка кнопок меню ---
  switch (text) {
    case 'Назад': {
      await safeDelete(chatId, lastNavCircleByChat[chatId]);
      delete lastNavCircleByChat[chatId];
      await safeDelete(chatId, lastCalendarPromptByChat[chatId]);
      delete lastCalendarPromptByChat[chatId];
      try { const prevR = lastIncomingGroupReplyMsgByChat[chatId] || []; for (const id of prevR) { await safeDelete(chatId, id); } delete lastIncomingGroupReplyMsgByChat[chatId]; } catch (_) {}
      clearUserState(chatId);
      awaitingEventName[chatId] = false;

      const role = getEffectiveRole(chatId);
      if (role === ROLES.GUEST) {
        updateUserProfile(chatId, { currentRole: ROLES.GUEST });
        bot.sendMessage(chatId, 'Выберите действие:', { 
          reply_markup: getGuestMenu() 
        });
      return;
      } else {
        bot.sendMessage(chatId, 'Возвращаемся в ваше меню:', { reply_markup: getMenuByRole(chatId) });
        return;
      }
    }

    case 'Техническая поддержка':
      await safeDelete(chatId, lastNavCircleByChat[chatId]);
      delete lastNavCircleByChat[chatId];
      await safeDelete(chatId, lastIncCircleByChat[chatId]);
      delete lastIncCircleByChat[chatId];
      await safeDelete(chatId, lastSupportInfoMsgByChat[chatId]);
      await safeDelete(chatId, lastSupportInlineMsgByChat[chatId]);
      clearUserState(chatId);
      const faqText = [
        '<b>Часто задаваемые вопросы (FAQ)</b>',
        '',
        '<b>Оплата обучения</b>',
        '• Оплата производится по реквизитам колледжа. Реквизиты и образец квитанции можно получить в учебной части или на сайте.',
        '• Сроки и порядок оплаты указаны в вашем договоре на обучение.',
        '',
        '<b>Адрес колледжа</b>',
        '• Нижегородская, 6.',
        '',
        '<b>Общие вопросы</b>',
        '• Как узнать расписание? — раздел «Расписание».',
        '• Не нашли нужную группу/преподавателя? — используйте подсказки или обратитесь в техподдержку.',
        '• Как поменять группу? — откройте «Расписание группы» и нажмите кнопку «Изменить группу».',
        '',
        '<b>Навигация по меню</b>',
        '• «Расписание» — выбор между «Расписание группы» и «Расписание преподавателя».',
        '• «Навигация» — поиск аудитории.',
        '• «Оповестить студентов» — для преподавателей.',
        '• «Техническая поддержка» — быстро задать вопрос.',
      ].join('\n');
      const infoMsg = await bot.sendMessage(chatId, faqText, { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
      lastSupportInfoMsgByChat[chatId] = infoMsg.message_id;
      const menuMsg = await bot.sendMessage(chatId, 'Если информации недостаточно, обратитесь в техподдержку:', {
        reply_markup: { inline_keyboard: [[{ text: 'Задать вопрос', url: SUPPORT_BOT_URL }], [{ text: 'В меню', callback_data: 'BACK_TO_MENU' }]] }
      });
      lastSupportInlineMsgByChat[chatId] = menuMsg.message_id;
      return;

    case 'Документы HR':
      await safeDelete(chatId, lastNavCircleByChat[chatId]);
      delete lastNavCircleByChat[chatId];
      await safeDelete(chatId, lastIncCircleByChat[chatId]);
      delete lastIncCircleByChat[chatId];
      await safeDelete(chatId, lastSupportInfoMsgByChat[chatId]);
      await safeDelete(chatId, lastSupportInlineMsgByChat[chatId]);
      clearUserState(chatId);
      const hrMsg = await bot.sendMessage(chatId, '<b>Документы HR:</b>\n• Справка с места работы/учёбы\n• Заявление на отпуск\n• Заявление на командировку\n• Справка 2‑НДФЛ\n\nЧтобы получить документ или шаблон, нажмите «Запросить документ».', { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
      lastSupportInfoMsgByChat[chatId] = hrMsg.message_id;
      const hrMenu = await bot.sendMessage(chatId, 'Запросить документ:', {
        reply_markup: {
          inline_keyboard: [[{
            text: 'Запросить документ', url: SUPPORT_BOT_URL }], [{ text: 'В меню', callback_data: 'BACK_TO_MENU' }]]
        }
      });
      lastSupportInlineMsgByChat[chatId] = hrMenu.message_id;
      return;

    case 'Служебные заявки': 
      await safeDelete(chatId, lastNavCircleByChat[chatId]);
      delete lastNavCircleByChat[chatId];
      await safeDelete(chatId, lastIncCircleByChat[chatId]);
      delete lastIncCircleByChat[chatId];
      await safeDelete(chatId, lastSupportInfoMsgByChat[chatId]);
      await safeDelete(chatId, lastSupportInlineMsgByChat[chatId]);
      clearUserState(chatId);
      const reqMsg = await bot.sendMessage(chatId, '<b>Служебные заявки</b>\n• Заявка на оборудование\n• Заявка на доступ/пропуск\n• Заявка на ремонт рабочего места\n• Другое\n\nНажмите «Оформить заявку», чтобы отправить запрос.', {
        parse_mode: 'HTML',
        reply_markup: {
          remove_keyboard: true
        }
      });
      lastSupportInfoMsgByChat[chatId] = reqMsg.message_id;
      const reqMenu = await bot.sendMessage(chatId, 'Оформить заявку:', {
        reply_markup: {
          inline_keyboard: [[{
            text: 'Оформить заявку', url: SUPPORT_BOT_URL }], [{ text: 'В меню', callback_data: 'BACK_TO_MENU' }]]
        }
      });
      lastSupportInlineMsgByChat[chatId] = reqMenu.message_id;
      return;
    

    case 'Студент':
      clearUserState(chatId);
      updateUserProfile(chatId, { currentRole: ROLES.STUDENT });
      bot.sendMessage(chatId, 'Меню студента:', { reply_markup: getStudentMenu() });
      return;
    case 'Я абитуриент':
      clearUserState(chatId);
      updateUserProfile(chatId, { currentRole: ROLES.GUEST, role: 'guest' });
      bot.sendMessage(chatId, 'Меню абитуриента:', { reply_markup: getApplicantMenu() });
      return;

    case 'Преподаватель':
      clearUserState(chatId);
      updateUserProfile(chatId, { currentRole: ROLES.TEACHER });
      bot.sendMessage(chatId, 'Меню преподавателя:', { reply_markup: getTeacherMenu() });
      return;

    case 'Найти группу': {
      if (!hasAccess(chatId, ROLES.TEACHER)) {
        bot.sendMessage(chatId, '❌ Эта функция доступа только преподавателям. Если вы преподаватель, свяжитесь с администрацией.');
        return;
      } else {
        clearUserState(chatId);
        setUserState(chatId, 'awaiting_group');
        bot.sendMessage(chatId, 'Введите группу, которую вы ведёте (например, КИСП24140):');
        return;
      }
    }

    case 'Образовательные программы':
      clearUserState(chatId);
      await bot.sendMessage(chatId, 'Выберите образовательную программу', {
        reply_markup: { remove_keyboard: true }
      });
      await bot.sendMessage(chatId, 'Образовательные программы СИУ РАНХиГС:', getEPMenu());
      return;

    case 'Гость':
      clearUserState(chatId);
      updateUserProfile(chatId, { currentRole: ROLES.GUEST });
      bot.sendMessage(chatId, 'Меню гостя:', {
        reply_markup: getGuestMenu()
      });
      return;

      case 'Я поступил':
        try {
          await safeDelete(chatId, lastIncCircleByChat[chatId]);
          const note = await bot.sendVideoNote(chatId, VIDEO_NOTE_INCOMING_ID);
          lastIncCircleByChat[chatId] = note.message_id;
        } catch (e) {
          console.error('start video_note FAIL for', chatId, e?.response?.body || e.message);
        }
        clearUserState(chatId);
        bot.sendMessage(chatId, 'Ты поступил! Поздравляем!',{
          reply_markup: getIncomingMenu()
        });
      
      return;

      case 'Наставник - кто это?': {
        clearUserState(chatId);

        const mentorData = FAQ.mentor;

        if (!mentorData) {
            bot.sendMessage(chatId, "❗ Информация о наставниках отсутствует.");
            return;
        }

        // Если есть картинка в FAQ.json
        if (mentorData.image) {
            bot.sendPhoto(chatId, mentorData.image, {
                caption: mentorData.about,
                parse_mode: "HTML",
                reply_markup: getIncomingMenu()
            });
        } else {
            // Если картинки нет, просто текст
            bot.sendMessage(chatId, mentorData.about, {
                parse_mode: "HTML",
                reply_markup: getIncomingMenu()
            });
        }
        return;
    }

  case 'Календарь первокурсника': {
    clearUserState(chatId);

    const text = "<b>📅 Выберите месяц:</b>";
    const markup = getCalendarMenu().reply_markup;

    await safeDelete(chatId, lastIncCircleByChat[chatId]);
    delete lastIncCircleByChat[chatId];

    // 1) сначала убираем обычную клавиатуру
  // важно: это отдельное сообщение, чтобы Telegram точно снял reply keyboard
  const rm = await bot.sendMessage(chatId, "Открываю календарь…", {
    reply_markup: { remove_keyboard: true }
  });
  lastCalendarPromptByChat[chatId] = rm.message_id;

    // 2) дальше работаем с inline-сообщением (одно на чат)
    if (lastCalendarMsgByChat[chatId]) {
      try {
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: lastCalendarMsgByChat[chatId],
          parse_mode: "HTML",
          reply_markup: markup
        });
        return;
      } catch (e) {
        lastCalendarMsgByChat[chatId] = null;
      }
    }

    const m = await bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: markup
    });
    lastCalendarMsgByChat[chatId] = m.message_id;
    return;
  
    }

    case 'Найти свою группу': {
      await safeDelete(chatId, lastIncCircleByChat[chatId]);
      delete lastIncCircleByChat[chatId];
      clearUserState(chatId);
      setUserState(chatId, 'awating_incoming_group');
      const m = await bot.sendMessage(chatId, 'Введите номер вашей группы: (например 24140КИСП)');
      lastIncomingGroupPromptsByChat[chatId] = [m.message_id];
      return;
    }

    case 'Общежитие': {
      // await safeDelete(chatId, lastIncCircleByChat[chatId]);
      // delete lastIncCircleByChat[chatId];
      clearUserState(chatId);
      const text = "<b>Общежития СИУ РАНХиГС</b>\n\n• Условия заселения, сроки и список документов.\n• Контакты и адреса общежитий.\n• Порядок оплаты и проживания.\n\nПодробная информация на сайте:";
      await bot.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "Перейти на сайт", url: DORM_URL }] ] }
      });
      return;
    }

    case 'Полезные ссылки': {
      clearUserState(chatId);
      const text = "<b>Полезные ссылки для студентов</b>\n\nВыберите ресурс:";
      await bot.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Сайт СИУ РАНХиГС", url: SITE_SIU_URL }],
            [{ text: "Студентам", url: STUDENT_PAGE_URL }],
            [{ text: "Расписание", url: SCHEDULE_URL }],
            [{ text: "Портал РАНХиГС", url: RANEPA_PORTAL_URL }]
          ]
        }
      });
      return;
    }

    case 'Сотрудник':
      clearUserState(chatId);
      updateUserProfile(chatId, { currentRole: ROLES.EMPLOYEE });
      bot.sendMessage(chatId, 'Меню сотрудника:', {
        reply_markup: getEmployeeMenu()
      });
      return;

    case 'Навигация':
      await safeDelete(chatId, lastIncCircleByChat[chatId]);
      delete lastIncCircleByChat[chatId];
      clearUserState(chatId);
      try {
        await safeDelete(chatId, lastNavCircleByChat[chatId]);
        const note = await bot.sendVideoNote(chatId, VIDEO_NOTE_NAVIGATION_ID);
        lastNavCircleByChat[chatId] = note.message_id;
      } catch (e) {
        console.error('start video_note FAIL for', chatId, e?.response?.body || e.message);
      }
      bot.sendMessage(chatId, 'Навигация по кампусу. Что вас интересует?', {
        reply_markup: getNavigationMenu()
      });
      return;

    case 'Найти аудиторию': {
      await safeDelete(chatId, lastIncCircleByChat[chatId]);
      delete lastIncCircleByChat[chatId];
      clearUserState(chatId);
      await safeDelete(chatId, lastNavCircleByChat[chatId]);
      delete lastNavCircleByChat[chatId];
      const mapKeyboard = {
        inline_keyboard: [
          [ MAP_URL.startsWith('https://') ? { text: 'Открыть карту', web_app: { url: MAP_URL } } : { text: 'Открыть карту', url: MAP_URL } ],
        ]
      };
      bot.sendMessage(chatId, 'Карта колледжа', { reply_markup: mapKeyboard });
      return;
    }

    case 'Расписание группы': {
      const profile = getUserProfile(chatId);
      if (!profile.group) {
        setUserState(chatId, 'awaiting_group');
        await showGroupPrompt(chatId);
        return;
      }
      const schedule = getSchedule(profile.group);
      const inline = {
        inline_keyboard: [
          [{ text: 'Изменить группу', callback_data: 'BACK_TO_GROUP_INPUT' }]
        ]
      };
      if (schedule) {
        bot.sendMessage(chatId, `Расписание для группы ${profile.group}:\n\n${schedule}`, {
          reply_markup: inline
        });
      } else {
        bot.sendMessage(chatId, 'Расписание для этой группы не найдено.', {
          reply_markup: inline
        });
      }
      return;
    }

    case 'Расписание преподавателя': {
      setUserState(chatId, 'awaiting_teacher');
      const prevT = lastTeacherPromptsByChat[chatId] || [];
      for (const id of prevT.slice(-2)) { await safeDelete(chatId, id); }
      const m1 = await bot.sendMessage(chatId, 'Введите ФИО или фамилию преподавателя:', { reply_markup: { inline_keyboard: [[{ text: 'В меню', callback_data: 'BACK_TO_MENU' }]] } });
      lastTeacherPromptsByChat[chatId] = [m1.message_id];
      return;
    }

    case 'Расписание': {
      bot.sendMessage(chatId, 'Выберете чье расписание вы хотите посмотреть: ', { 
        reply_markup: getMenuSchedule() 
      });
      return;
    }

    case 'Оповестить студентов': {
      bot.sendMessage(chatId, 'Выберите что вы хотите сделать:', { reply_markup: getMenuBroadcast() });
      return;
    }

    case 'Оповестить группу': {
      if (!hasAccess(chatId, ROLES.TEACHER)) {
        bot.sendMessage(chatId, '❌ Эта функция доступа только преподавателям. Если вы преподаватель, свяжитесь с администрацией.');
        return;
      } else {
        clearUserState(chatId);
        setUserState(chatId, 'awaiting_group_broadcast');
        bot.sendMessage(chatId, 'Введите группу, которую вы хотите оповестить (например, КИСП24140):');
        return;
      }
    }

    case 'Оповестить все группы': {
      if (!hasAccess(chatId, ROLES.TEACHER)) {
        bot.sendMessage(chatId, '❌ Эта функция доступа только преподавателям. Если вы преподаватель, свяжитесь с администрацией.');
        return;
      }
      clearUserState(chatId);
      setUserState(chatId, 'awaiting_broadcast_all');
      bot.sendMessage(chatId, 'Введите сообщение для рассылки всем группам:');
      return;
    }

    case 'Журнал': { // для препода
      if (!hasAccess(chatId, ROLES.TEACHER)) {
        bot.sendMessage(chatId, '❌ Эта функция доступна только преподавателям. Если вы преподаватель, свяжитесь с тех. поддержкой.');
        return;
      }
      const profile = getUserProfile(chatId);
      if (!profile.group) {
        setUserState(chatId, 'awaiting_group');
        const promptMsg = await bot.sendMessage(chatId, 'Сначала найдите группу с помощью кнопки "Найти группу".', {
          reply_markup: {
            inline_keyboard: [[{ text: 'Найти группу', callback_data: 'BACK_TO_GROUP_INPUT' }]]
          }
        });
        lastGroupPromptsByChat[chatId] = [promptMsg.message_id];
        return;
      }
      const students = getGroupGrades(profile.group);
      if (!students.length) {
        bot.sendMessage(chatId, 'Группа не найдена или нет студентов.');
        return;
      }
      let msg = `Оценки студентов группы ${profile.group}:\n\n`;
      students.forEach(s => {
        msg += `${s.firstName} ${s.lastName}:\n`;
        for (const [subject, grade] of Object.entries(s.grades || {})) {
          msg += `  ${subject}: ${grade}\n`;
        }
        msg += '\n';
      });
      const prevP = lastGroupPromptsByChat[chatId] || [];
      for (const id of prevP.slice(-2)) await safeDelete(chatId, id);
      lastGroupPromptsByChat[chatId] = [];
      const m = await bot.sendMessage(chatId, msg, { 
        reply_markup: {
          inline_keyboard: [[{ text: 'Назад', callback_data: 'BACK_TO_GROUP_INPUT' }]]
        }
      });
      lastGroupPromptsByChat[chatId] = [m.message_id];
      return;
    }

    case 'Оценки': { // для студента
      const profile = getUserProfile(chatId);
      const userRole = getUserRolePhone(chatId);
      if (userRole !== ROLES.STUDENT && userRole !== ROLES.ADMIN) {
        bot.sendMessage(chatId, '❌ Эта функция доступна только студентам или администраторами.');
        return;
      }
      if (!profile.group) {
        setUserState(chatId, 'awaiting_group');
        await showGroupPrompt(chatId, 'Сначала укажите вашу группу (например, 24140КИСП):');
        return;
      }
      if (!profile.firstName || !profile.lastName) {
        setUserState(chatId, 'awaiting_name', { group: profile.group });
        bot.sendMessage(chatId, 'Пожалуйста, введите имя и фамилию через пробел.');
        return;
      }
      const grades = getGrades(profile.group, profile.firstName, profile.lastName);
      if (grades) {
        let msg = `Оценки для ${profile.firstName} ${profile.lastName} в группе ${profile.group}:\n\n`;
        for (const [subject, grade] of Object.entries(grades)) {
          msg += `${subject}: ${grade}\n`;
        }
        bot.sendMessage(chatId, msg, { reply_markup: getStudentMenu() });
      } else {
        bot.sendMessage(chatId, 'Оценки для этого студента не найдены.');
      }
      return;
    }
      
    case 'Я участник мероприятия': // для гостя
      // Устанавливаем состояние — теперь следующий текст пользователя будет считаться названием мероприятия
      awaitingEventName[chatId] = true;
      bot.sendMessage(chatId, 'Введите название мероприятия, которое вас интересует:', {
        reply_markup: getEventMenu()
      });
      return;

    case 'Модерация':
      if (!hasAccess(chatId, ROLES.ADMIN)) {
        bot.sendMessage(chatId, '❌ Эта функция доступна только администраторам.');
        return;
      }
      try { await safeDelete(chatId, lastModerationPromptByChat[chatId]); } catch (_) {}
      try { await safeDelete(chatId, lastModerationListByChat[chatId]); } catch (_) {}
      const rm = await bot.sendMessage(chatId, 'Панель модерации:', { reply_markup: { remove_keyboard: true } });
      const modRoot = {
        inline_keyboard: [
          [ { text: 'Роли', callback_data: 'MOD_PANEL_ROLES' }, { text: 'Рассылка сообщений', callback_data: 'MOD_PANEL_BROADCAST' } ],
          [ { text: 'В меню', callback_data: 'BACK_TO_MENU'} ]
        ]
      };
      const list = await bot.sendMessage(chatId, 'Выберите раздел:', { reply_markup: modRoot });
      lastModerationPromptByChat[chatId] = rm.message_id;
      lastModerationListByChat[chatId] = list.message_id;
      return;

    default: {
      const hasPending = awaitingEventName[chatId] || (getUserState(chatId) && getUserState(chatId).state);
      if (!hasPending) {
        bot.sendMessage(chatId, 'Я не распознал ваше сообщение. Попробуйте еще раз.');
        console.log('пользователь неправильно ввел кнопку или сообщение') // логи
      }
      break;
    }
  }

  // --- Если ожидаем название мероприятия ---
  if (awaitingEventName[chatId]) {
    const userInput = text.trim();

    if (userInput === 'Назад') {
      clearUserState(chatId);
      awaitingEventName[chatId] = false;

      const role = getEffectiveRole(chatId);
      if (role === ROLES.GUEST) {
        updateUserProfile(chatId, { currentRole: ROLES.GUEST });
        bot.sendMessage(chatId, 'Выберите действие:', { reply_markup: getGuestMenu() });
      } else {
        bot.sendMessage(chatId, 'Возвращаемся в ваше меню:', { reply_markup: getMenuByRole(chatId) });
      }
      return;
    }

    if (userInput === 'Навигация') {
      await clearUserState(chatId);
      await bot.sendMessage(chatId, 'Навигация по кампусу. Что вас интересует?', { reply_markup: getNavigationMenu() });
      return;
    }

    if (userInput === 'Я участник мероприятия') {
      bot.sendMessage(chatId, 'Введите название мероприятия, которое вас интересует:', { reply_markup: getEventMenu() });
      return;
    }

    awaitingEventName[chatId] = false;

    const { match, suggestions } = findEvent(userInput);

    if (match) {
      await handleEventSelection(chatId, null, match);
      return;
    }

    if (suggestions.length > 0) {
      await bot.sendMessage(chatId, 'Похожие мероприятия:', {
        reply_markup: {
          inline_keyboard: suggestions.map(ev => [{ text: ev, callback_data: 'event_' + ev }])
        }
      });
      return;
    }

    await bot.sendMessage(chatId, 'Мероприятие не найдено', { reply_markup: { remove_keyboard: true } });

    await bot.sendMessage(chatId, 'Попробуйте ввести название ещё раз:', {
      reply_markup: {
        inline_keyboard: [[{ text: 'В меню', callback_data: 'BACK_TO_MENU' }, { text: 'Все мероприятия', callback_data: 'ALL_EVENTS' }]],
        remove_keyboard: true
      }
    });

    awaitingEventName[chatId] = true;
    return;
  }

  // --- Обработка состояний (awaiting_group, confirm_groupи т.д.) ---
  if (text && !text.startsWith('/') && getUserState(chatId).state) {
    const { state, data } = getUserState(chatId);

    if (state === 'awaiting_group') {
      const result = findGroup(text);

      if (result.match) {
        updateUserProfile(chatId, { group: result.match });
        // Сохраняем группу пользователя в базу
        try {
          usersDb.users = usersDb.users || {};
          let key = Object.keys(usersDb.users).find(k => String(usersDb.users[k].chatId) === String(chatId));
          if (!key) key = String(chatId);
          const existing = usersDb.users[key] || { chatId };
          usersDb.users[key] = { ...existing, group: result.match };
          saveDb();
        } catch (e) {
          console.error('Ошибка сохранения группы пользователя:', e?.message || e);
        }
        setUserState(chatId, 'group_selected', { group: result.match });
        const userRole = getEffectiveRole(chatId);
        if (userRole === ROLES.TEACHER) {
          bot.sendMessage(chatId, `Группа ${result.match} выбрана. Теперь вы можете просмотреть расписание.`, { reply_markup: getTeacherMenu() });
        } else if (userRole === ROLES.STUDENT) {
          bot.sendMessage(chatId, `Группа ${result.match} выбрана. Теперь вы можете просмотреть расписание или оценки.`, { reply_markup: getStudentMenu() });
        } else {
          bot.sendMessage(chatId, '❌ У вас нет доступа к этой функции.');
        }
        clearUserState(chatId);
      } else if (result.suggestions.length > 0) {
        try {
          const prevP = lastGroupPromptsByChat[chatId] || [];
          for (const id of prevP.slice(-2)) { await safeDelete(chatId, id); }
          lastGroupPromptsByChat[chatId] = [];
        } catch (_) {}
        const buttons = result.suggestions.map((sug) => [{ text: sug, callback_data: `CONFIRM_GROUP:${sug}` }]);
        buttons.push([{ text: 'Назад', callback_data: 'BACK_TO_GROUP_INPUT' }]);
        setUserState(chatId, 'confirm_group', { suggestions: result.suggestions });
        const mA = await bot.sendMessage(chatId, 'Группа не найдена точно. Возможно, вы имели в виду одну из этих? Выберите вариант:', {
          reply_markup: { remove_keyboard: true }
        });
        const mB = await bot.sendMessage(chatId, 'Выберите группу из вариантов или нажмите «Назад».', {
          reply_markup: { inline_keyboard: buttons }
        });
        lastGroupSuggestByChat[chatId] = [mA.message_id, mB.message_id];
      } else {
        bot.sendMessage(chatId, 'Группа не найдена. Попробуйте ввести снова или используйте полное название.');
      }
    } else if (state === 'awaiting_teacher') {
      const teacherInput = (text || '').trim();
      const result = findTeacher(teacherInput);
      if (result.record) {
        try {
          const prevS = lastTeacherSuggestByChat[chatId] || [];
          for (const id of prevS.slice(-2)) { await safeDelete(chatId, id); }
          lastTeacherSuggestByChat[chatId] = [];
        } catch (_) {}
        const schedule = getTeacherScheduleByRecord(result.record);
        if (schedule) {
          setUserState(chatId, 'teacher_day_select', { teacherName: result.record.nameFull, teacherGroup: result.record.group });
          await bot.sendMessage(chatId, `Выберите день для преподавателя ${result.record.nameFull}:`, {
            reply_markup: { remove_keyboard: true }
          });
          await bot.sendMessage(chatId, `Нажмите на одну из кнопок ниже, чтобы выбрать день.`, {
            reply_markup: { inline_keyboard: getDaySelectMenu().inline_keyboard }
          });
        } else {
          bot.sendMessage(chatId, 'Расписание для этого преподавателя не найдено. Введите фамилию/ФИО снова или нажмите «Назад».');
          // оставляем состояние awaiting_teacher
        }
      } else if (result.suggestions.length > 0) {
        try {
          const prevP = lastTeacherPromptsByChat[chatId] || [];
          for (const id of prevP.slice(-2)) { await safeDelete(chatId, id); }
          lastTeacherPromptsByChat[chatId] = [];
        } catch (_) {}
        const buttons = result.suggestions.map((sug) => [{ text: sug, callback_data: `CONFIRM_TEACHER:${sug}` }]);
        buttons.push([{ text: 'Назад', callback_data: 'BACK_TO_TEACHER_INPUT' }]);
        setUserState(chatId, 'confirm_teacher', { suggestions: result.suggestions });
        const mA2 = await bot.sendMessage(chatId, 'Преподаватель не найден точно. Возможно, вы имели в виду одного из этих? Выберите вариант:', {
          reply_markup: { remove_keyboard: true }
        });
        const mB2 = await bot.sendMessage(chatId, 'Выберите преподавателя из вариантов или нажмите «Назад».', {
          reply_markup: { inline_keyboard: buttons }
        });
        lastTeacherSuggestByChat[chatId] = [mA2.message_id, mB2.message_id];
      } else {
        bot.sendMessage(chatId, 'Преподаватель не найден. Введите фамилию/ФИО снова или нажмите «Назад».');
        // оставляем состояние awaiting_teacher
      }
    } else if (state === 'awaiting_name') {
      const parts = text.trim().split(' ');
      if (parts.length < 2) {
        bot.sendMessage(chatId, 'Пожалуйста, введите имя и фамилию через пробел.');
        return;
      }
      const firstName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
      const lastName = parts.slice(1).map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
      updateUserProfile(chatId, { firstName, lastName });

      const grades = getGrades(data.group, firstName, lastName);
      if (grades) {
        let msg = `Оценки для ${firstName} ${lastName} в группе ${data.group}:\n\n`;
        for (const [subject, grade] of Object.entries(grades)) {
          msg += `${subject}: ${grade}\n`;
        }
        bot.sendMessage(chatId, msg, { reply_markup: getStudentMenu() });
      } else {
        bot.sendMessage(chatId, 'Студент с таким именем и фамилией не найден в группе. Пожалуйста, введите имя и фамилию повторно:');
        return; // оставляем состояние awaiting_name
      }
      clearUserState(chatId);
    } else if (state === 'awaiting_group_broadcast') {
      const result = findGroup(text);
      if (result.match) {
        updateUserProfile(chatId, { group: result.match });
        setUserState(chatId, 'group_broadcast_selected', { group: result.match });
        const userRole = getEffectiveRole(chatId);
        if (userRole === ROLES.TEACHER) {
          bot.sendMessage(chatId, `Группа ${result.match} выбрана. Теперь отправьте им сообщение.`);
        } else {
          bot.sendMessage(chatId, '❌ У вас нет доступа к этой функции.');
          clearUserState(chatId);
        }
      } else if (result.suggestions.length > 0) {
        const buttons = result.suggestions.map((sug) => [{ text: sug, callback_data: `CONFIRM_GROUP_BROADCAST:${sug}` }]);
        setUserState(chatId, 'confirm_group_broadcast', { suggestions: result.suggestions });
        bot.sendMessage(chatId, 'Группа не найдена точно. Возможно, вы имели в виду одну из этих? Выберите вариант:', {
          reply_markup: { inline_keyboard: buttons }
        });
      } else {
        bot.sendMessage(chatId, 'Группа не найдена. Попробуйте ввести снова или используйте полное название.');
      }
    } else if (state === 'group_broadcast_selected') {
      const groupName = data.group;
      const target = resolveGroupChatTarget(groupName);
      if (!target) {
        bot.sendMessage(chatId, `❗ Для группы ${groupName} не указан chatId/@username группового чата. Добавьте поле chatId (например -100...) или chatUsername (@...) в bdshka/bazary.json → groups.${groupName}.`);
        clearUserState(chatId);
        return;
      }
      const allowed = await canBotSendToChat(target);
      if (!allowed) {
        bot.sendMessage(chatId, `❌ Бот не имеет права писать в чат группы ${groupName}. Убедитесь, что бот добавлен и не ограничен. Если это канал — дайте боту права администратора.`);
        clearUserState(chatId);
        return;
      }
      try {
        const out = makeTeacherMessage(chatId, text, msg);
        await bot.sendMessage(target, out, { parse_mode: 'HTML' });
        bot.sendMessage(chatId, `Сообщение отправлено в групповой чат группы ${groupName}.`, { reply_markup: getTeacherMenu() });
      } catch (e) {
        const d = e && e.response && e.response.body && e.response.body.description;
        console.error('Broadcast group error:', d || e);
        bot.sendMessage(chatId, `❌ Не удалось отправить сообщение в чат группы ${groupName}. ${d || ''}`.trim(), { reply_markup: getTeacherMenu() });
      }
      clearUserState(chatId);
    } else if (state === 'awating_incoming_group'){
      try {
        const prevP = lastIncomingGroupPromptsByChat[chatId] || [];
        for (const id of prevP) { await safeDelete(chatId, id); }
        lastIncomingGroupPromptsByChat[chatId] = [];
        const prevS = lastIncomingGroupSuggestByChat[chatId] || [];
        for (const id of prevS) { await safeDelete(chatId, id); }
        lastIncomingGroupSuggestByChat[chatId] = [];
        const prevR = lastIncomingGroupReplyMsgByChat[chatId] || [];
        for (const id of prevR) { await safeDelete(chatId, id); }
        lastIncomingGroupReplyMsgByChat[chatId] = [];
      } catch (_) {}
      const result = findGroup(text);
      if (result.match){
        const buttons = [[{ text: result.match, callback_data: `INCOMING_CONFIRM_GROUP:${result.match}`}]];
        const m = await bot.sendMessage(chatId, 'Найдена группа:', { reply_markup: { inline_keyboard: buttons } });
        lastIncomingGroupSuggestByChat[chatId] = [m.message_id];

      } else if (result.suggestions.length > 0) {
        const buttons = result.suggestions.map(s =>[{text: s, callback_data: `INCOMING_CONFIRM_GROUP:${s}`}]);
        const m = await bot.sendMessage(chatId, 'Возможные совпадения:', { reply_markup: { inline_keyboard: buttons } });
        lastIncomingGroupSuggestByChat[chatId] = [m.message_id];

      } else {
        const m = await bot.sendMessage(chatId, 'Группа не найдена. Попробуйте еще раз.', { reply_markup: getIncomingMenu() });
        lastIncomingGroupPromptsByChat[chatId] = [m.message_id];
      }
    } else if (state === 'awaiting_broadcast_all') {
      const targets = getAllGroupChatTargets();
      if (targets.length === 0) {
        bot.sendMessage(chatId, '❗ Не найдено ни одного группового чата. Укажите chatId/@username для учебных групп в bdshka/bazary.json.', { reply_markup: getTeacherMenu() });
        clearUserState(chatId);
        return;
      }
      let ok = 0;
      for (const t of targets) {
        try {
          const out = makeTeacherMessage(chatId, text, msg);
          await bot.sendMessage(t, out, { parse_mode: 'HTML' });
          ok++;
        } catch (e) {
          const d = e && e.response && e.response.body && e.response.body.description;
          console.error('Broadcast all error:', d || e);
        }
      }
      bot.sendMessage(chatId, `Рассылка выполнена. Доставлено в ${ok} групповых чатов.`, { reply_markup: getTeacherMenu() });
      clearUserState(chatId);
    } else if (state === 'awaiting_set_role_for_target') {
      const roleRaw = (data && data.role) || '';
      const targetRef = (text || '').trim();
      const allowed = ['student','teacher','admin','employee','guest'];
      if (!allowed.includes(roleRaw) || !targetRef) {
        bot.sendMessage(chatId, 'Укажите корректную роль и пользователя.');
        return;
      }
      const roleMap = {
        student: ROLES.STUDENT,
        teacher: ROLES.TEACHER,
        admin: ROLES.ADMIN,
        employee: ROLES.EMPLOYEE,
        guest: ROLES.GUEST,
      };
      usersDb.users = usersDb.users || {};
      let targetChatId = null;
      let targetKey = null;
      if (targetRef.startsWith('@')) {
        const uname = targetRef.slice(1);
        const unameLc = uname.toLowerCase();
        targetKey = Object.keys(usersDb.users).find(k => (usersDb.users[k].username || '') === uname);
        if (targetKey) targetChatId = usersDb.users[targetKey].chatId || null;
        if (!targetKey) {
          let matchedCid = null;
          try {
            for (const [cid, profile] of userProfiles.entries()) {
              const pu = (profile.username || '').toLowerCase();
              if (pu && pu === unameLc) { matchedCid = cid; break; }
            }
          } catch (_) {}
          if (matchedCid) {
            targetChatId = matchedCid;
            const existingByCid = Object.keys(usersDb.users).find(k => String(usersDb.users[k].chatId) === String(matchedCid));
            if (existingByCid) {
              usersDb.users[existingByCid].username = uname;
            } else {
              usersDb.users[String(matchedCid)] = { chatId: matchedCid, username: uname };
            }
            targetKey = String(matchedCid);
          } else {
            targetKey = uname;
          }
        }
        usersDb.roles = usersDb.roles || { byChatId: {}, byUsername: {} };
        usersDb.roles.byUsername[unameLc] = roleRaw;
      } else {
        const numericId = Number(targetRef);
        if (!Number.isFinite(numericId)) {
          bot.sendMessage(chatId, 'Некорректный идентификатор. Укажите @username или числовой chatId.');
          return;
        }
        // Ищем существующую запись по chatId
        targetKey = Object.keys(usersDb.users).find(k => String(usersDb.users[k].chatId) === String(numericId));
        if (targetKey) {
          usersDb.roles = usersDb.roles || { byChatId: {}, byUsername: {} };
          usersDb.roles.byChatId[String(numericId)] = roleRaw;
        } else {
          // Пытаемся найти username из профилей по этому chatId
          let unameFromProfile = null;
          try {
            const prof = getUserProfile(numericId);
            if (prof && prof.username) unameFromProfile = prof.username;
          } catch (_) {}
          if (unameFromProfile) {
            // Если в базе есть запись по username — обновляем её и добавляем chatId, вместо создания дубля
            const byUnameKey = Object.keys(usersDb.users).find(k => (usersDb.users[k].username || '') === unameFromProfile);
            if (byUnameKey) {
              usersDb.users[byUnameKey].chatId = numericId;
              usersDb.roles = usersDb.roles || { byChatId: {}, byUsername: {} };
              usersDb.roles.byChatId[String(numericId)] = roleRaw;
              usersDb.roles.byUsername[String(unameFromProfile).toLowerCase()] = roleRaw;
              targetKey = byUnameKey;
            } else {
              // Иначе создаём запись по chatId
              usersDb.users[String(numericId)] = { chatId: numericId, username: unameFromProfile };
              usersDb.roles = usersDb.roles || { byChatId: {}, byUsername: {} };
              usersDb.roles.byChatId[String(numericId)] = roleRaw;
              usersDb.roles.byUsername[String(unameFromProfile).toLowerCase()] = roleRaw;
              targetKey = String(numericId);
            }
          } else {
            // Нет username — создаём запись по chatId
            usersDb.users[String(numericId)] = { chatId: numericId };
            usersDb.roles = usersDb.roles || { byChatId: {}, byUsername: {} };
            usersDb.roles.byChatId[String(numericId)] = roleRaw;
            targetKey = String(numericId);
          }
        }
        targetChatId = numericId;
      }
      saveDb();
      if (targetChatId) {
        updateUserProfile(targetChatId, { currentRole: roleMap[roleRaw], role: roleRaw });
      } else if (targetRef.startsWith('@')) {
        const uname = targetRef.slice(1).toLowerCase();
        for (const [cid, profile] of userProfiles.entries()) {
          const pu = (profile.username || '').toLowerCase();
          if (pu && pu === uname) {
            updateUserProfile(cid, { currentRole: roleMap[roleRaw], role: roleRaw });
          }
        }
      }
      try { await safeDelete(chatId, lastModerationPromptByChat[chatId]); } catch (_) {}
      try { await safeDelete(chatId, lastModerationListByChat[chatId]); } catch (_) {}
      await bot.sendMessage(chatId, `Роль пользователя ${targetRef} установлена: ${roleRaw}.`, { reply_markup: getMenuByRole(chatId) });
      clearUserState(chatId);
    } else if (state === 'admin_broadcast_group_name') {
      const result = findGroup(text);
      if (result.match) {
        setUserState(chatId, 'admin_broadcast_group_message', { group: result.match });
        const rm = await bot.sendMessage(chatId, `Группа ${result.match} выбрана. Введите текст сообщения для рассылки.`, { reply_markup: { remove_keyboard: true } });
        lastModerationPromptByChat[chatId] = rm.message_id;
      } else if (result.suggestions && result.suggestions.length > 0) {
        const buttons = result.suggestions.map((s) => [{ text: s, callback_data: `ADMIN_CONFIRM_GROUP_BROADCAST:${s}` }]);
        buttons.push([{ text: 'К разделам', callback_data: 'MOD_PANEL_ROOT' }, { text: 'В меню', callback_data: 'BACK_TO_MENU' }]);
        const mA = await bot.sendMessage(chatId, 'Группа не найдена точно. Возможно вы имели в виду:', { reply_markup: { remove_keyboard: true } });
        const mB = await bot.sendMessage(chatId, 'Выберите из вариантов:', { reply_markup: { inline_keyboard: buttons } });
        lastModerationPromptByChat[chatId] = mA.message_id;
        lastModerationListByChat[chatId] = mB.message_id;
      } else {
        await bot.sendMessage(chatId, 'Группа не найдена. Попробуйте снова или используйте полное название.');
      }
    } else if (state === 'admin_broadcast_group_message') {
      const groupName = (data && data.group) || '';
      const target = resolveGroupChatTarget(groupName);
      if (!target) {
        bot.sendMessage(chatId, `❗ Для группы ${groupName} не указан chatId/@username чата.`);
        clearUserState(chatId);
        return;
      }
      try {
        await bot.sendMessage(target, text);
        const rm = await bot.sendMessage(chatId, `Отправлено в чат группы ${groupName}.`, { reply_markup: { remove_keyboard: true } });
        const modRoot = { inline_keyboard: [[{ text: 'Роли', callback_data: 'MOD_PANEL_ROLES' }, { text: 'Рассылка сообщений', callback_data: 'MOD_PANEL_BROADCAST' }], [{ text: 'В меню', callback_data: 'BACK_TO_MENU' }]] };
        const list = await bot.sendMessage(chatId, 'Панель модерации: Выберите раздел:', { reply_markup: modRoot });
        lastModerationPromptByChat[chatId] = rm.message_id;
        lastModerationListByChat[chatId] = list.message_id;
      } catch (e) {
        const d = e && e.response && e.response.body && e.response.body.description;
        bot.sendMessage(chatId, `❌ Не удалось отправить. ${d || ''}`.trim());
      }
      clearUserState(chatId);
    } else if (state === 'admin_broadcast_all_message') {
      const targets = getAllGroupChatTargets();
      let ok = 0;
      for (const t of targets) {
        try { await bot.sendMessage(t, text); ok++; } catch (_) {}
      }
      const rm = await bot.sendMessage(chatId, `Рассылка выполнена: доставлено в ${ok} чатов.`, { reply_markup: { remove_keyboard: true } });
      const modRoot = { inline_keyboard: [[{ text: 'Роли', callback_data: 'MOD_PANEL_ROLES' }, { text: 'Рассылка сообщений', callback_data: 'MOD_PANEL_BROADCAST' }], [{ text: 'В меню', callback_data: 'BACK_TO_MENU' }]] };
      const list = await bot.sendMessage(chatId, 'Панель модерации: Выберите раздел:', { reply_markup: modRoot });
      lastModerationPromptByChat[chatId] = rm.message_id;
      lastModerationListByChat[chatId] = list.message_id;
      clearUserState(chatId);
    } else if (state === 'admin_broadcast_all_users_message') {
      try { await safeDelete(chatId, lastModerationPromptByChat[chatId]); } catch (_) {}
      try { await safeDelete(chatId, lastModerationListByChat[chatId]); } catch (_) {}
      const targets = new Set();
      try { for (const [k, info] of Object.entries(usersDb.users || {})) { if (info && info.chatId) targets.add(info.chatId); } } catch (_) {}
      try { for (const cid of userProfiles.keys()) { targets.add(cid); } } catch (_) {}
      let okUsers = 0;
      for (const t of targets) {
        try {
          const p = Object.values(usersDb.users || {}).find(x => x && String(x.chatId) === String(t));
          const uname = p && p.username ? `@${p.username}` : '';
          const out = `${uname ? uname + '\n' : ''}${text}`;
          await bot.sendMessage(t, out);
          okUsers++;
        } catch (_) {}
      }
      const rm = await bot.sendMessage(chatId, `Рассылка пользователям выполнена: доставлено ${okUsers}.`, { reply_markup: { remove_keyboard: true } });
      const modRoot = { inline_keyboard: [[{ text: 'Роли', callback_data: 'MOD_PANEL_ROLES' }, { text: 'Рассылка сообщений', callback_data: 'MOD_PANEL_BROADCAST' }], [{ text: 'В меню', callback_data: 'BACK_TO_MENU' }]] };
      const list = await bot.sendMessage(chatId, 'Панель модерации: Выберите раздел:', { reply_markup: modRoot });
      lastModerationPromptByChat[chatId] = rm.message_id;
      lastModerationListByChat[chatId] = list.message_id;
      clearUserState(chatId);
    }
  }
}
);

// Функция для получения оценок студента в группе
function getGrades(groupName, firstName, lastName) {
  const normalizedFirst = (firstName || '').toLowerCase().trim();
  const normalizedLast = (lastName || '').toLowerCase().trim();
  for (const info of Object.values(usersDb.users)) {
    if ((info.group || '').trim() === groupName && info.firstName && info.lastName) {
      const fn = info.firstName.toLowerCase().trim();
      const ln = info.lastName.toLowerCase().trim();
      if (fn === normalizedFirst && ln === normalizedLast) {
        return info.grades || null;
      }
    }
  }
  return null;
}

// Получить всех студентов и их оценки по группе
function getGroupGrades(groupName) {
  const students = [];
  for (const info of Object.values(usersDb.users)) {
    if ((info.group || '').trim() === groupName) {
      students.push({
        firstName: info.firstName || '',
        lastName: info.lastName || '',
        grades: info.grades || {}
      });
    }
  }
  return students;
}


// Универсальное определение цели отправки: chatId или @username
function resolveGroupChatTarget(groupName) {
  const g = groupsDb.groups && groupsDb.groups[groupName];
  if (!g) return null;
  if (g.chatId) return g.chatId; // -100...
  if (g.chatUsername) return g.chatUsername; // @groupname
  return null;
}

function getAllGroupChatTargets() {
  const groups = groupsDb.groups || {};
  const targets = [];
  for (const g of Object.values(groups)) {
    if (!g) continue;
    if (g.chatId) targets.push(g.chatId);
    else if (g.chatUsername) targets.push(g.chatUsername);
  }
  return targets;
}

async function canBotSendToChat(target) {
  try {
    const me = await bot.getMe();
    const member = await bot.getChatMember(target, me.id);
    const status = member && member.status;
    if (status === 'kicked' || status === 'left') return false;
    if (status === 'administrator' || status === 'member' || status === 'creator') return true;
    if (status === 'restricted') {
      // В ограниченном статусе проверяем, может ли бот отправлять сообщения
      return !!member.can_send_messages;
    }
    return false;
  } catch (e) {
    return false;
  }
}



function makeTeacherMessage(chatId, text, msg) {
  const profile = getUserProfile(chatId);
  const username = (msg && msg.from && msg.from.username) || profile.username || '';
  let first = '';
  let last = '';
  const unameLower = (username || '').toLowerCase();
  let matched = null;
  for (const info of Object.values(usersDb.users)) {
    const idMatch = String(info.chatId) === String(chatId);
    const uMatch = (info.username ? String(info.username).toLowerCase() : '') === unameLower;
    if (idMatch || (unameLower && uMatch)) { matched = info; break; }
  }
  if (matched) {
    first = matched.firstName || '';
    last = matched.lastName || '';
  }
  if (!first && !last) {
    first = profile.firstName || '';
    last = profile.lastName || '';
  }
  if (!first && !last && msg && msg.from) {
    first = msg.from.first_name || '';
    last = msg.from.last_name || '';
  }
  const name = [first, last].filter(Boolean).join(' ').trim();
  const display = name || (username ? '@' + username : 'преподаватель');
  const link = `<a href="tg://user?id=${chatId}">${display}</a>`;
  return `${text}\n\n— Преподаватель: ${link}`;
}

 

let lastPostByChat = {};
let lastSelectPromptByChat = {};
let lastSelectListByChat = {};
let lastEventCardByChat = {};
let lastNavCircleByChat = {};
let lastIncCircleByChat = {};
let lastCalendarPromptByChat = {};
let lastIncomingGroupPromptsByChat = {};
let lastIncomingGroupSuggestByChat = {};
let lastIncomingGroupReplyMsgByChat = {};
let lastSupportInfoMsgByChat = {};
let lastSupportInlineMsgByChat = {};

async function safeDelete(chatId, messageId) {
  if (!messageId) return;
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (e) {
    const d = e && e.response && e.response.body && e.response.body.description;
    const s = e && e.response && e.response.statusCode;
    const ignorable = (s === 400) && (d && (d.includes('message to delete not found') || d.includes('message not found') || d.includes("can't be deleted") || d.includes('message is too old')));
    if (!ignorable) {
      const msg = d || (e && e.message) || 'deleteMessage failed';
      console.error(msg);
    }
  }
}

async function handleEventSelection(chatId, q, eventName) {
  await safeDelete(chatId, q && q.message && q.message.message_id);
  await safeDelete(chatId, lastSelectPromptByChat[chatId]);
  await safeDelete(chatId, lastSelectListByChat[chatId]);
  delete lastSelectPromptByChat[chatId];
  delete lastSelectListByChat[chatId];
  await safeDelete(chatId, lastEventCardByChat[chatId]);
  delete lastEventCardByChat[chatId];
  await safeDelete(chatId, lastPostByChat[chatId]);
  delete lastPostByChat[chatId];

  const eventDetails = eventsDb.events[eventName];
  if (!eventDetails) {
    await bot.sendMessage(chatId, 'Мероприятие с таким названием не найдено.');
    if (q && q.id) {
      await bot.answerCallbackQuery(q.id);
    }
    return;
  }

  const m = await bot.sendMessage(chatId, 'Ваше мероприятие:', { reply_markup: { remove_keyboard: true } });
  lastPostByChat[chatId] = m.message_id;

  const eventButtons = [
    [
      { text: 'Все мероприятия', callback_data: 'ALL_EVENTS' },
      { text: 'Назад', callback_data: 'EVENT_BACK' },
      { text: 'В меню', callback_data: 'BACK_TO_MENU' }
    ]
  ];

  if (eventDetails.image) {
    try {
      const photoMsg = await bot.sendPhoto(chatId, eventDetails.image, {
        caption: formatEventCard(eventDetails),
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: eventButtons }
      });
      lastEventCardByChat[chatId] = photoMsg.message_id;
    } catch (e) {
      const textMsg = await bot.sendMessage(chatId, formatEventCard(eventDetails), {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: eventButtons }
      });
      lastEventCardByChat[chatId] = textMsg.message_id;
    }
  } else {
    const textMsg = await bot.sendMessage(chatId, formatEventCard(eventDetails), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: eventButtons }
    });
    lastEventCardByChat[chatId] = textMsg.message_id;
  }

  if (q && q.id) {
    await bot.answerCallbackQuery(q.id);
  }
}

// Каллбек для обработки нажатий на кнопки мероприятий
bot.on('callback_query', async (q) => {
  try {
    const chatId = q.message.chat.id;
    const chatType = q.message.chat && q.message.chat.type;
    const data = (q && q.data) ? q.data : '';

    await safeDelete(chatId, lastIncCircleByChat[chatId]);
    delete lastIncCircleByChat[chatId];
    if (chatType && chatType !== 'private') {
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === 'MOD_PANEL_ROLES') {
      try { await safeDelete(chatId, q.message && q.message.message_id); } catch (_) {}
      try { await safeDelete(chatId, lastModerationPromptByChat[chatId]); } catch (_) {}
      try { await safeDelete(chatId, lastModerationListByChat[chatId]); } catch (_) {}
      const rm = await bot.sendMessage(chatId, 'Раздел: Роли', { reply_markup: { remove_keyboard: true } });
      const modMenu = {
        inline_keyboard: [
          [
            { text: 'Роль себе: Студент', callback_data: 'admin_set_role:student' },
            { text: 'Роль себе: Преподаватель', callback_data: 'admin_set_role:teacher' }
          ],
          [
            { text: 'Роль себе: Админ', callback_data: 'admin_set_role:admin' },
            { text: 'Роль себе: Сотрудник', callback_data: 'admin_set_role:employee' }
          ],
          [ { text: 'Роль себе: Гость', callback_data: 'admin_set_role:guest' } ],
          [ { text: 'Назначить роль пользователю', callback_data: 'MOD_CHOOSE_ROLE_FOR_USER' } ],
          [ { text: 'К разделам', callback_data: 'MOD_PANEL_ROOT' }, { text: 'В меню', callback_data: 'BACK_TO_MENU' } ]
        ]
      };
      const list = await bot.sendMessage(chatId, 'Выберите действие:', { reply_markup: modMenu });
      lastModerationPromptByChat[chatId] = rm.message_id;
      lastModerationListByChat[chatId] = list.message_id;
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === 'MOD_PANEL_BROADCAST') {
      try { await safeDelete(chatId, q.message && q.message.message_id); } catch (_) {}
      try { await safeDelete(chatId, lastModerationPromptByChat[chatId]); } catch (_) {}
      try { await safeDelete(chatId, lastModerationListByChat[chatId]); } catch (_) {}
      const rm = await bot.sendMessage(chatId, 'Раздел: Рассылка сообщений', { reply_markup: { remove_keyboard: true } });
      const menu = {
        inline_keyboard: [
          [ { text: 'Оповестить группу', callback_data: 'MOD_BROADCAST_GROUP' }, { text: 'Оповестить все группы', callback_data: 'MOD_BROADCAST_ALL' } ],
          [ { text: 'Оповестить всех пользователей бота', callback_data: 'MOD_BROADCAST_ALL_USERS' } ],
          [ { text: 'К разделам', callback_data: 'MOD_PANEL_ROOT' }, { text: 'В меню', callback_data: 'BACK_TO_MENU' } ]
        ]
      };
      const list = await bot.sendMessage(chatId, 'Выберите действие:', { reply_markup: menu });
      lastModerationPromptByChat[chatId] = rm.message_id;
      lastModerationListByChat[chatId] = list.message_id;
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === 'MOD_PANEL_ROOT') {
      try { await safeDelete(chatId, q.message && q.message.message_id); } catch (_) {}
      try { await safeDelete(chatId, lastModerationPromptByChat[chatId]); } catch (_) {}
      try { await safeDelete(chatId, lastModerationListByChat[chatId]); } catch (_) {}
      const rm = await bot.sendMessage(chatId, 'Панель модерации:', { reply_markup: { remove_keyboard: true } });
      const modRoot = {
        inline_keyboard: [
          [ { text: 'Роли', callback_data: 'MOD_PANEL_ROLES' }, { text: 'Рассылка сообщений', callback_data: 'MOD_PANEL_BROADCAST' } ],
          [ { text: 'В меню', callback_data: 'BACK_TO_MENU' } ]
        ]
      };
      const list = await bot.sendMessage(chatId, 'Выберите раздел:', { reply_markup: modRoot });
      lastModerationPromptByChat[chatId] = rm.message_id;
      lastModerationListByChat[chatId] = list.message_id;
      await bot.answerCallbackQuery(q.id);
      return;
    }
    
    if (data.startsWith('event_')) {
      await handleEventSelection(chatId, q, data.replace('event_', ''));
      return;
    }
    
    

    if (data === 'ALL_EVENTS') {
      const eventNames = Object.keys(eventsDb.events);
      await safeDelete(chatId, lastPostByChat[chatId]);
      delete lastPostByChat[chatId];
      await safeDelete(chatId, lastEventCardByChat[chatId]);
      delete lastEventCardByChat[chatId];
      await safeDelete(chatId, lastSelectPromptByChat[chatId]);
      await safeDelete(chatId, lastSelectListByChat[chatId]);
      delete lastSelectPromptByChat[chatId];
      delete lastSelectListByChat[chatId];
      await safeDelete(chatId, q.message && q.message.message_id);

      if (eventNames.length === 0) {
        await bot.sendMessage(chatId, 'Список мероприятий пуст.', {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'В меню', callback_data: 'BACK_TO_MENU' }]
            ]
          }
        });
      } else {
        const eventButtons = eventNames.map(eventName => [
          { text: eventName, callback_data: 'event_' + eventName }
        ]);

        eventButtons.push([{ text: 'В меню', callback_data: 'BACK_TO_MENU' }]);

        const listMsg = await bot.sendMessage(chatId, 'Выберите мероприятие:', {
          reply_markup: {
            inline_keyboard: eventButtons
          }
        });
        lastSelectPromptByChat[chatId] = listMsg.message_id;
        lastSelectListByChat[chatId] = listMsg.message_id;
      }
      return;
    }

    if (data.startsWith('admin_set_role:')) {
      const roleRaw = data.substring('admin_set_role:'.length);
      const allowed = ['student','teacher','admin','employee','applicant','guest'];
      if (!allowed.includes(roleRaw)) {
        await bot.answerCallbackQuery(q.id);
        return;
      }
      const roleMap = {
        student: ROLES.STUDENT,
        teacher: ROLES.TEACHER,
        admin: ROLES.ADMIN,
        employee: ROLES.EMPLOYEE,
        guest: ROLES.GUEST,
      };
      try { await safeDelete(chatId, q.message && q.message.message_id); } catch (_) {}
      try { await safeDelete(chatId, lastModerationPromptByChat[chatId]); } catch (_) {}
      try { await safeDelete(chatId, lastModerationListByChat[chatId]); } catch (_) {}
      updateUserProfile(chatId, { currentRole: roleMap[roleRaw], role: roleRaw });
      const username = q.from && q.from.username;
      usersDb.roles = usersDb.roles || { byChatId: {}, byUsername: {} };
      usersDb.roles.byChatId[String(chatId)] = roleRaw;
      if (username) usersDb.roles.byUsername[String(username).toLowerCase()] = roleRaw;
      saveDb();
      try { await safeDelete(chatId, lastModerationPromptByChat[chatId]); } catch (_) {}
      try { await safeDelete(chatId, lastModerationListByChat[chatId]); } catch (_) {}
      await bot.sendMessage(chatId, `Роль установлена: ${roleRaw}.`, { reply_markup: getMenuByRole(chatId) });
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data.startsWith('admin_set_role_for:')) {
      const roleRaw = data.substring('admin_set_role_for:'.length);
      const allowed = ['student','teacher','admin','employee','applicant','guest'];
      if (!allowed.includes(roleRaw)) {
        await bot.answerCallbackQuery(q.id);
        return;
      }
      try { await safeDelete(chatId, q.message && q.message.message_id); } catch (_) {}
      try { await safeDelete(chatId, lastModerationListByChat[chatId]); } catch (_) {}
      try { await safeDelete(chatId, lastModerationPromptByChat[chatId]); } catch (_) {}
      setUserState(chatId, 'awaiting_set_role_for_target', { role: roleRaw });
      const rm2 = await bot.sendMessage(chatId, `Выбрана роль: ${roleRaw}. Теперь отправьте @username или chatId пользователя.`, { reply_markup: { remove_keyboard: true } });
      const list2 = await bot.sendMessage(chatId, 'Если передумали — нажмите «Назад».', {
        reply_markup: { inline_keyboard: [[{ text: 'Назад', callback_data: 'MOD_PANEL_ROLES' }, { text: 'В меню', callback_data: 'BACK_TO_MENU' }]] }
      });
      lastModerationPromptByChat[chatId] = rm2.message_id;
      lastModerationListByChat[chatId] = list2.message_id;
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === 'MOD_BROADCAST_GROUP') {
      try { await safeDelete(chatId, q.message && q.message.message_id); } catch (_) {}
      try { await safeDelete(chatId, lastModerationPromptByChat[chatId]); } catch (_) {}
      try { await safeDelete(chatId, lastModerationListByChat[chatId]); } catch (_) {}
      setUserState(chatId, 'admin_broadcast_group_name');
      const rm = await bot.sendMessage(chatId, 'Рассылка в группу: введите название группы (например, 24140КИСП).', { reply_markup: { remove_keyboard: true } });
      const list = await bot.sendMessage(chatId, 'После ввода группы бот попросит текст сообщения.', { reply_markup: { inline_keyboard: [[{ text: 'К разделам', callback_data: 'MOD_PANEL_ROOT' }, { text: 'В меню', callback_data: 'BACK_TO_MENU' }]] } });
      lastModerationPromptByChat[chatId] = rm.message_id;
      lastModerationListByChat[chatId] = list.message_id;
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === 'MOD_BROADCAST_ALL') {
      try { await safeDelete(chatId, q.message && q.message.message_id); } catch (_) {}
      try { await safeDelete(chatId, lastModerationPromptByChat[chatId]); } catch (_) {}
      try { await safeDelete(chatId, lastModerationListByChat[chatId]); } catch (_) {}
      setUserState(chatId, 'admin_broadcast_all_message');
      const rm = await bot.sendMessage(chatId, 'Рассылка во все группы: введите текст сообщения.', { reply_markup: { remove_keyboard: true } });
      const list = await bot.sendMessage(chatId, 'Сообщение будет отправлено во все групповые чаты.', { reply_markup: { inline_keyboard: [[{ text: 'К разделам', callback_data: 'MOD_PANEL_ROOT' }, { text: 'В меню', callback_data: 'BACK_TO_MENU' }]] } });
      lastModerationPromptByChat[chatId] = rm.message_id;
      lastModerationListByChat[chatId] = list.message_id;
      await bot.answerCallbackQuery(q.id);
      return;
    }

    

    if (data === 'MOD_BROADCAST_ALL_USERS') {
      try { await safeDelete(chatId, q.message && q.message.message_id); } catch (_) {}
      try { await safeDelete(chatId, lastModerationPromptByChat[chatId]); } catch (_) {}
      try { await safeDelete(chatId, lastModerationListByChat[chatId]); } catch (_) {}
      setUserState(chatId, 'admin_broadcast_all_users_message');
      const rm = await bot.sendMessage(chatId, 'Рассылка всем пользователям бота: введите текст сообщения.', { reply_markup: { remove_keyboard: true } });
      const list = await bot.sendMessage(chatId, 'Сообщение будет отправлено каждому пользователю, писавшему боту.', { reply_markup: { inline_keyboard: [[{ text: 'К разделам', callback_data: 'MOD_PANEL_ROOT' }, { text: 'В меню', callback_data: 'BACK_TO_MENU' }]] } });
      lastModerationPromptByChat[chatId] = rm.message_id;
      lastModerationListByChat[chatId] = list.message_id;
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === 'MOD_CHOOSE_ROLE_FOR_USER') {
      try { await safeDelete(chatId, q.message && q.message.message_id); } catch (_) {}
      try { await safeDelete(chatId, lastModerationPromptByChat[chatId]); } catch (_) {}
      try { await safeDelete(chatId, lastModerationListByChat[chatId]); } catch (_) {}
      const rm = await bot.sendMessage(chatId, 'Выбор роли для пользователя:', { reply_markup: { remove_keyboard: true } });
      const chooseMenu = {
        inline_keyboard: [
          [
            { text: 'Студент', callback_data: 'admin_set_role_for:student'},
            { text: 'Преподаватель', callback_data: 'admin_set_role_for:teacher'},
          ],
          [
            { text: 'Админ', callback_data: 'admin_set_role_for:admin'},
            { text: 'Сотрудник', callback_data: 'admin_set_role_for:employee'},
          ],
          [ { text: 'Гость', callback_data: 'admin_set_role_for:guest'} ],
          [ { text: 'К разделам', callback_data: 'MOD_PANEL_ROOT' }, { text: 'В меню', callback_data: 'BACK_TO_MENU'} ]
        ]
      };
      const list = await bot.sendMessage(chatId, 'Выберите роль которую назначить пользователю:', { reply_markup: chooseMenu });
      lastModerationPromptByChat[chatId] = rm.message_id;
      lastModerationListByChat[chatId] = list.message_id;
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data.startsWith('ADMIN_CONFIRM_GROUP_BROADCAST:')) {
      const g = data.substring('ADMIN_CONFIRM_GROUP_BROADCAST:'.length);
      setUserState(chatId, 'admin_broadcast_group_message', { group: g });
      try { await safeDelete(chatId, q.message && q.message.message_id); } catch (_) {}
      const rm = await bot.sendMessage(chatId, `Группа ${g} выбрана. Введите текст сообщения.`, { reply_markup: { remove_keyboard: true } });
      lastModerationPromptByChat[chatId] = rm.message_id;
      await bot.answerCallbackQuery(q.id);
      return;
    }
    // Универсальный возврат в главное меню
    if (data === 'BACK_TO_MENU') {
        awaitingEventName[chatId] = false;
        await safeDelete(chatId, q.message && q.message.message_id);
        await safeDelete(chatId, lastPostByChat[chatId]);
        await safeDelete(chatId, lastEventCardByChat[chatId]);
        await safeDelete(chatId, lastSelectPromptByChat[chatId]);
        await safeDelete(chatId, lastSelectListByChat[chatId]);
        await safeDelete(chatId, lastNavCircleByChat[chatId]);
        await safeDelete(chatId, lastIncCircleByChat[chatId]);
        await safeDelete(chatId, lastCalendarPromptByChat[chatId]);
        await safeDelete(chatId, lastSupportInfoMsgByChat[chatId]);
        await safeDelete(chatId, lastSupportInlineMsgByChat[chatId]);
        await safeDelete(chatId, (lastIncomingGroupReplyMsgByChat[chatId] || [])[0]);
        await safeDelete(chatId, lastModerationPromptByChat[chatId]);
        await safeDelete(chatId, lastModerationListByChat[chatId]);
        delete lastPostByChat[chatId];
        delete lastEventCardByChat[chatId];
        delete lastSelectPromptByChat[chatId];
        delete lastSelectListByChat[chatId];
        delete lastNavCircleByChat[chatId];
        delete lastIncCircleByChat[chatId];
        delete lastCalendarPromptByChat[chatId];
        delete lastSupportInfoMsgByChat[chatId];
        delete lastSupportInlineMsgByChat[chatId];
        delete lastIncomingGroupReplyMsgByChat[chatId];
        delete lastModerationPromptByChat[chatId];
        delete lastModerationListByChat[chatId];
        await bot.sendMessage(chatId, 'Возвращаемся в главное меню:', {
            reply_markup: getMenuByRole(chatId)
        });
        await bot.answerCallbackQuery(q.id);
        return;
    }

    

    // Обработка подтверждения выбора группы
    if (data.startsWith('CONFIRM_GROUP:')) {
      const selected = data.substring('CONFIRM_GROUP:'.length);
      try {
        const prevS = lastGroupSuggestByChat[chatId] || [];
        for (const id of prevS.slice(-2)) { await safeDelete(chatId, id); }
        lastGroupSuggestByChat[chatId] = [];
        if (q.message && q.message.message_id) await safeDelete(chatId, q.message.message_id);
      } catch (_) {}
      try {
        const prevP = lastGroupPromptsByChat[chatId] || [];
        for (const id of prevP.slice(-2)) { await safeDelete(chatId, id); }
        lastGroupPromptsByChat[chatId] = [];
      } catch (_) {}
      updateUserProfile(chatId, { group: selected });
      // Сохраняем группу пользователя в базу
      try {
        usersDb.users = usersDb.users || {};
        let key = Object.keys(usersDb.users).find(k => String(usersDb.users[k].chatId) === String(chatId));
        if (!key) key = String(chatId);
        const existing = usersDb.users[key] || { chatId };
        usersDb.users[key] = { ...existing, group: selected };
        saveDb();
      } catch (e) {
        console.error('Ошибка сохранения группы пользователя:', e?.message || e);
      }
      setUserState(chatId, 'group_selected', { group: selected });
      
      const userRole = getEffectiveRole(chatId);
      if (userRole === ROLES.TEACHER) {
        bot.sendMessage(chatId, `Группа ${selected} подтверждена. Теперь вы можете просмотреть расписание.`, {
          reply_markup: getTeacherMenu()
        });
      } else if (userRole === ROLES.STUDENT) {
        bot.sendMessage(chatId, `Группа ${selected} подтверждена. Теперь вы можете просмотреть расписание или оценки.`, {
          reply_markup: getStudentMenu()
        });
      } else {
        bot.sendMessage(chatId, '❌ У вас нет доступа к этой функции.');
      }
      clearUserState(chatId);
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data.startsWith('CONFIRM_GROUP_BROADCAST:')) {
      const selected = data.substring('CONFIRM_GROUP_BROADCAST:'.length);
      setUserState(chatId, 'group_broadcast_selected', { group: selected });
      bot.sendMessage(chatId, `Группа ${selected} подтверждена. Теперь отправьте им сообщение.`);
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data.startsWith('INCOMING_CONFIRM_GROUP:')) {
      const selected = data.substring('INCOMING_CONFIRM_GROUP:'.length);
      try {
        const prevP = lastIncomingGroupPromptsByChat[chatId] || [];
        for (const id of prevP) { await safeDelete(chatId, id); }
        const prevS = lastIncomingGroupSuggestByChat[chatId] || [];
        for (const id of prevS) { await safeDelete(chatId, id); }
        const prevR = lastIncomingGroupReplyMsgByChat[chatId] || [];
        for (const id of prevR) { await safeDelete(chatId, id); }
        lastIncomingGroupPromptsByChat[chatId] = [];
        lastIncomingGroupSuggestByChat[chatId] = [];
        lastIncomingGroupReplyMsgByChat[chatId] = [];
      } catch (_) {}
      const g = groupsDb.groups && groupsDb.groups[selected];
      
      const parts = [];
      parts.push(`Группа: ${selected}`);
      // if (g && g.schedule) parts.push(`Расписание:\n${g.schedule}`);
      if (g && g.link) { parts.push(`🔗Ссылка на беседу: ${g.link}`);
      } else if (g && g.chatUsername){
        const usr = g.chatUsername.replace('@', '');
        parts.push(`Ссылка на беседу: https://t.me/${usr}`);
      } else if (g && g.chatId) {
        parts.push(`ID беседы: ${g.chatId}`);
      }
      const out = parts.join('\n\n');
      const hasLink = (g && (g.link || g.chatUsername || g.chatId));
      await bot.sendMessage(chatId, out || `Информация о группе ${selected} недоступна.`, hasLink ? { reply_markup: getIncomingMenu() } : undefined);
      await bot.answerCallbackQuery(q.id);
      return;
    }

    // Выбор дня для расписания преподавателя
    if (data.startsWith('TEACHER_DAY:')) {
      const day = data.substring('TEACHER_DAY:'.length);
      const st = getUserState(chatId);
      const teacherName = (st && st.data && st.data.teacherName) || null;
      const teacherGroup = (st && st.data && st.data.teacherGroup) || null;
      const byName = teacherName ? getSchedule(teacherName) : null;
      const byGroup = teacherGroup ? getSchedule(teacherGroup) : null;
      const schedule = byName || byGroup;
      if (schedule) {
        const chunk = extractDaySchedule(String(schedule), day);
        if (chunk) {
          await bot.sendMessage(chatId, chunk);
        } else {
          await bot.sendMessage(chatId, `Не удалось выделить расписание на день: ${day}. Полное расписание:\n\n${schedule}`);
        }
      } else {
        await bot.sendMessage(chatId, 'Расписание для этого преподавателя не найдено.');
      }
      await bot.answerCallbackQuery(q.id);
      return;
    }

    // Подтверждение выбора преподавателя из подсказок
    if (data.startsWith('CONFIRM_TEACHER:')) {
      const selected = data.substring('CONFIRM_TEACHER:'.length);
      const rec = getTeacherRecordByDisplayName(selected);
      const schedule = rec ? getTeacherScheduleByRecord(rec) : getSchedule(selected);
      try {
        const prevS = lastTeacherSuggestByChat[chatId] || [];
        for (const id of prevS.slice(-2)) { await safeDelete(chatId, id); }
        lastTeacherSuggestByChat[chatId] = [];
        if (q.message && q.message.message_id) await safeDelete(chatId, q.message.message_id);
      } catch (_) {}
      if (schedule) {
        const nameOut = rec ? rec.nameFull : selected;
        setUserState(chatId, 'teacher_day_select', { teacherName: nameOut, teacherGroup: rec && rec.group });
        await bot.sendMessage(chatId, `Выберите день для преподавателя ${nameOut}:`, {
          reply_markup: { remove_keyboard: true }
        });
        await bot.sendMessage(chatId, `Нажмите на одну из кнопок ниже, чтобы выбрать день.`, {
          reply_markup: { inline_keyboard: getDaySelectMenu().inline_keyboard }
        });
      } else {
        await bot.sendMessage(chatId, 'Расписание для этого преподавателя не найдено. Введите фамилию/ФИО снова или нажмите «Назад».');
        setUserState(chatId, 'awaiting_teacher');
      }
      await bot.answerCallbackQuery(q.id);
      return;
    }

    //  Обработка кнопки "Назад"
    if (data === 'Назад') {
      await safeDelete(chatId, lastCalendarPromptByChat[chatId]);
      delete lastCalendarPromptByChat[chatId];
      await safeDelete(chatId, lastNavCircleByChat[chatId]);
      delete lastNavCircleByChat[chatId];
      await safeDelete(chatId, lastIncCircleByChat[chatId]);
      delete lastIncCircleByChat[chatId];
      try { const prevR = lastIncomingGroupReplyMsgByChat[chatId] || []; for (const id of prevR) { await safeDelete(chatId, id); } delete lastIncomingGroupReplyMsgByChat[chatId]; } catch (_) {}
      bot.sendMessage(chatId, 'Возвращаемся в меню:', {
        reply_markup: getMenuByRole(chatId)
      });
      await bot.answerCallbackQuery(q.id);
      return;
    }

    // Возврат к вводу преподавателя из списка подсказок
    if (data === 'BACK_TO_TEACHER_INPUT') {
      setUserState(chatId, 'awaiting_teacher');
      const prevT = lastTeacherPromptsByChat[chatId] || [];
      for (const id of prevT.slice(-2)) { await safeDelete(chatId, id); }
      const m1 = await bot.sendMessage(chatId, 'Введите ФИО или фамилию преподавателя:', { reply_markup: { remove_keyboard: true } });
      lastTeacherPromptsByChat[chatId] = [m1.message_id];
      await bot.answerCallbackQuery(q.id);
      return;
    }

    // Возврат к вводу группы из списка подсказок
    if (data === 'BACK_TO_GROUP_INPUT') {
      setUserState(chatId, 'awaiting_group');
      await showGroupPrompt(chatId);
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data.startsWith('event_')) {
      await handleEventSelection(chatId, q, data.replace('event_', ''));
      return;
    }


// Образовательные программы
    if (EP.programs[data]) {
        const program = EP.programs[data];

        // Удаляем сообщение с категорией программ, чтобы не накапливались сообщения
        try {
            await bot.deleteMessage(chatId, q.message.message_id);
        } catch (e) {
            // если сообщение уже удалено, просто игнорируем
        }

        // Кнопки: возврат к списку образовательных программ и в главное меню
        const programButtons = [
            [
                { text: "Назад", callback_data: "EP_MENU_BACK" },
                { text: "В меню", callback_data: "BACK_TO_MENU" }
            ]
        ];

        await bot.sendMessage(chatId, formatEPCard(program), {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: programButtons }
        });

        await bot.answerCallbackQuery(q.id);
        return;
    }

    // Возвращение к списку образовательных программ
    if (data === "EP_MENU_BACK") {
        // Удаляем текущую карточку программы
        try {
            await bot.deleteMessage(chatId, q.message.message_id);
        } catch (e) {}
        // Показываем список категорий образовательных программ
        await bot.sendMessage(chatId, "Образовательные программы СМУ РАНХиГС:", getEPMenu());
        await bot.answerCallbackQuery(q.id);
        return;
    }

    // Возвращение в главное меню (для совместимости с существующей логикой)
    if (data === "EP_BACK") {
        await bot.sendMessage(chatId, "Возвращаемся в главное меню:", {
            reply_markup: getMenuByRole(chatId)
        });
        await bot.answerCallbackQuery(q.id);
        return;
    }

    // Возврат из карточки мероприятия к запросу его названия
    if (data === 'EVENT_BACK') {
        // Удаляем текущее сообщение (карточку мероприятия)
        try {
            await bot.deleteMessage(chatId, q.message.message_id);
        } catch (e) {}
        await safeDelete(chatId, lastPostByChat[chatId]);
        await safeDelete(chatId, lastEventCardByChat[chatId]);
        delete lastEventCardByChat[chatId];
        delete lastPostByChat[chatId];
        // Ставим бота в режим ожидания нового ввода мероприятия
        awaitingEventName[chatId] = true;
        // Предлагаем пользователю снова ввести название мероприятия и даём кнопку возврата в меню
        await bot.sendMessage(chatId, 'Введите название мероприятия:', {
            reply_markup: {
                inline_keyboard: [
                    [ { text: 'В меню', callback_data: 'BACK_TO_MENU' }, { text: 'Список всех мероприятий', callback_data: 'ALL_EVENTS' } ]
                ]
            }
        });
        await bot.answerCallbackQuery(q.id);
        return;
    }



// --- INLINE КАЛЕНДАРЬ ---
// --- INLINE КАЛЕНДАРЬ ---
if (data.startsWith('CAL_')) {
  const code = data.replace('CAL_', ''); // 09,10,... или BACK

  await safeDelete(chatId, lastCalendarPromptByChat[chatId]);
  delete lastCalendarPromptByChat[chatId];

  // Назад из календаря
  if (code === 'BACK') {
    // удаляем календарное сообщение, чтобы не болталось в чате
    await safeDelete(chatId, q.message && q.message.message_id);
    delete lastCalendarMsgByChat[chatId];

    await bot.sendMessage(chatId, "Что тебя интересует?", {
      reply_markup: getIncomingMenu()
    });
    await bot.answerCallbackQuery(q.id);
    return;
  }

  const calendarText = FAQ.calendar?.months?.[code];

  if (!calendarText) {
    await bot.answerCallbackQuery(q.id, { text: "❗ Информация по этому месяцу отсутствует." });
    return;
  }

  // Редактируем ТЕКУЩЕЕ сообщение вместо отправки нового
  try {
    await bot.editMessageText(calendarText, {
      chat_id: chatId,
      message_id: q.message.message_id,
      parse_mode: "HTML",
      reply_markup: getCalendarMenu().reply_markup
    });
    // сохраним id на всякий случай (если вдруг пришли из другого места)
    lastCalendarMsgByChat[chatId] = q.message.message_id;
  } catch (e) {
    // fallback: если редактирование не вышло — удалим старое и пошлём новое одно
    await safeDelete(chatId, q.message && q.message.message_id);
    const m = await bot.sendMessage(chatId, calendarText, {
      parse_mode: "HTML",
      reply_markup: getCalendarMenu().reply_markup
    });
    lastCalendarMsgByChat[chatId] = m.message_id;
  }

  await bot.answerCallbackQuery(q.id);
  return;
}

    // По умолчанию просто подтверждаем нажатие
    await bot.answerCallbackQuery(q.id);

  } catch (err) {
    console.error('Error in callback_query handler:', err);
    try {
      if (q && q.id) {
        await bot.answerCallbackQuery(q.id, { text: 'Произошла ошибка' });
      }
    } catch (e) {
      console.error('Error answering callback query:', e);
    }
  }
});



// Функция для поиска группы с учетом регистра и частичного совпадения
function findGroup(input) {
  const normalizedInput = input.toUpperCase().trim();
  const groupNames = Object.keys(groupsDb.groups);
  
  // Точное совпадение (игнорируя регистр)
  const exactMatch = groupNames.find(name => name.toUpperCase() === normalizedInput);
  if (exactMatch) return { match: exactMatch, suggestions: [] };
  
  // Частичное совпадение
  const suggestions = groupNames.filter(name => name.toUpperCase().includes(normalizedInput));
  return { match: null, suggestions };
}

function getTeachersList() {
  const out = [];
  const rolesByCid = (usersDb.roles && usersDb.roles.byChatId) || {};
  const rolesByUname = (usersDb.roles && usersDb.roles.byUsername) || {};
  for (const info of Object.values(usersDb.users || {})) {
    if (!info) continue;
    const cid = info.chatId ? String(info.chatId) : null;
    const unameLower = (info.username || '').toLowerCase();
    const roleRaw = (cid && rolesByCid[cid]) || (unameLower && rolesByUname[unameLower]) || (info.role || '').toLowerCase();
    if (roleRaw !== 'teacher') continue;
    const firstName = info.firstName || '';
    const lastName = info.lastName || '';
    const nameFull = firstName && lastName ? `${firstName} ${lastName}` : (lastName || firstName);
    out.push({
      nameFull,
      firstName,
      lastName,
      username: info.username || '',
      chatId: info.chatId,
      group: info.group || ''
    });
  }
  return out;
}

function findTeacher(input) {
  const normalizedInput = (input || '').toUpperCase().trim();
  const list = getTeachersList();
  const names = list.map(r => r.nameFull).concat(list.map(r => r.lastName)).filter(Boolean);
  const unique = Array.from(new Set(names));
  if (!normalizedInput) return { record: null, suggestions: [] };

  const exactName = unique.find(n => n.toUpperCase() === normalizedInput);
  if (exactName) {
    const rec = list.find(r => r.nameFull.toUpperCase() === normalizedInput) || list.find(r => (r.lastName || '').toUpperCase() === normalizedInput);
    return { record: rec || null, suggestions: [] };
  }

  const partial = unique.filter(n => n.toUpperCase().includes(normalizedInput));
  if (partial.length > 0) return { record: null, suggestions: partial.slice(0, 10) };

  const scored = unique.map(n => ({ name: n, score: distance(normalizedInput, n.toUpperCase()) }))
    .sort((a,b) => a.score - b.score);
  const threshold = Math.max(2, Math.floor(normalizedInput.length / 2));
  const close = scored.filter(s => s.score <= threshold).map(s => s.name).slice(0, 10);
  return { record: null, suggestions: close };
}

function getTeacherRecordByDisplayName(name) {
  const list = getTeachersList();
  const up = (name || '').toUpperCase();
  return list.find(r => r.nameFull.toUpperCase() === up) || list.find(r => (r.lastName || '').toUpperCase() === up) || null;
}

function getTeacherScheduleByRecord(rec) {
  if (!rec) return null;
  const byName = getSchedule(rec.nameFull);
  if (byName) return byName;
  const byLast = rec.lastName ? getSchedule(rec.lastName) : null;
  if (byLast) return byLast;
  if (rec.group) {
    const byGroup = getSchedule(rec.group);
    if (byGroup) return byGroup;
  }
  return null;
}

// --- При завершении работы процесса сохраняем базы (не обязателен, но полезно) ---
process.on('SIGINT', () => {
  console.log('SIGINT — сохраняем данные и выходим');
  saveGroups();
  saveDb();
  saveEvents();
  process.exit();
});

process.on('SIGTERM', () => {
  console.log('SIGTERM — сохраняем данные и выходим');
  saveGroups();
  saveDb();
  saveEvents();
  process.exit();
});
