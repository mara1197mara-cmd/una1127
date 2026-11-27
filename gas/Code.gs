/**
 * 禾煎 HÉ JIAN｜線上訂單 × Google Sheet 後端（Google Apps Script）
 *
 * 功能
 *  - doPost：接收網站送出的訂單，以「商品」工作表的價格重新計算金額（防竄改），
 *            產生每日流水號訂單編號，寫入「訂單」與「訂單明細」，並寄 Email 通知店家。
 *  - doGet ：健康檢查；或以 ?action=status&orderNo=...&phone=... 查詢訂單狀態。
 *  - setup ：第一次使用時執行，自動建立所有工作表、欄位、下拉選單與預設資料。
 *  - 每日營業報表：installDailyReport() 建立每天晚上自動寄出的當日營收摘要。
 *
 * 部署方式請見同資料夾的 README.md。
 */

/* ============================== 設定 ============================== */

const SHEET = {
  ORDERS: '訂單',
  ITEMS: '訂單明細',
  PRODUCTS: '商品',
  STORES: '門市',
  SETTINGS: '設定'
};

const ORDER_HEADERS = ['訂單編號', '建立時間', '狀態', '取餐方式', '門市', '姓名', '手機', '宅配地址', '備註', '商品摘要', '小計', '運費', '總額', '來源'];
const ITEM_HEADERS = ['訂單編號', '建立時間', '商品編號', '商品名稱', '單價', '數量', '金額'];
const STATUS_LIST = ['新訂單', '製作中', '可取餐', '已出貨', '已完成', '已取消'];
const TYPE_LABEL = { dine: '內用', takeout: '外帶', delivery: '冷凍宅配' };
const TZ = 'Asia/Taipei';

/** 與網站 index.html 中 MENU / GIFTS 相同的預設商品（setup 時寫入「商品」工作表，之後以試算表為準） */
const DEFAULT_PRODUCTS = [
  ['p1', '招牌豬肉鍋貼', 80], ['p2', '韭菜蝦仁鍋貼', 110], ['p3', '麻辣牛肉鍋貼', 120],
  ['p4', '起司玉米鍋貼', 100], ['p5', '蔬食香菇鍋貼', 90], ['p6', '泡菜豬肉鍋貼', 95],
  ['d1', '高麗菜豬肉水餃', 75], ['d2', '鮮蝦玉米水餃', 105], ['d3', '紅油抄手', 90],
  ['b1', '酸辣湯', 45], ['b2', '玉米蛋花湯', 40], ['b3', '古早味紅茶', 30], ['b4', '手工無糖豆漿', 35],
  ['s1', '涼拌小黃瓜', 40], ['s2', '滷味拼盤', 70], ['s3', '皮蛋豆腐', 50],
  ['g1', '家庭常備組', 520], ['g2', '招財鍋貼禮盒', 880], ['g3', '節慶團圓雙層禮盒', 1580]
];

const DEFAULT_STORES = [
  ['flagship', '永康旗艦店'], ['xinyi', '信義店'], ['banqiao', '板橋府中店'], ['taichung', '台中勤美店']
];

const DEFAULT_SETTINGS = [
  ['通知Email', '', '新訂單通知寄送對象；留空則寄給部署此程式的帳號。多個請用逗號分隔'],
  ['寄送新訂單通知', '是', '是／否'],
  ['宅配運費', 150, '新台幣'],
  ['免運門檻', 1500, '小計達此金額免運'],
  ['暫停接單', '否', '設為「是」時網站送單會收到暫停接單訊息'],
  ['每日報表時間', 21, '0–23（整點），執行 installDailyReport 後生效']
];

/* ============================== 網站 API ============================== */

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'createOrder') return json_(createOrder_(body.order || {}));
    return json_({ ok: false, error: '未知的操作' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: '伺服器錯誤，請稍後再試' });
  }
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'status') return json_(lookupOrder_(p.orderNo, p.phone));
  return json_({ ok: true, service: '禾煎訂單 API', time: now_() });
}

/* ============================== 建立訂單 ============================== */

function createOrder_(order) {
  const settings = getSettings_();
  if (settings['暫停接單'] === '是') return { ok: false, error: '目前暫停線上接單，請直接致電門市，造成不便敬請見諒。' };

  // --- 1. 驗證欄位 ---
  const type = String(order.type || '');
  const name = clean_(order.name, 40);
  const phone = String(order.phone || '').replace(/[\s-]/g, '');
  const address = clean_(order.address, 120);
  const note = clean_(order.note, 200);
  const storeId = String(order.storeId || '');
  const items = Array.isArray(order.items) ? order.items : [];

  if (!TYPE_LABEL[type]) return { ok: false, error: '取餐方式不正確' };
  if (!name) return { ok: false, error: '請輸入姓名' };
  if (!/^09\d{8}$/.test(phone)) return { ok: false, error: '手機號碼格式不正確' };
  if (type === 'delivery' && address.length < 6) return { ok: false, error: '請輸入宅配地址' };
  if (!items.length || items.length > 50) return { ok: false, error: '購物車是空的' };

  const stores = getMap_(SHEET.STORES);
  const storeName = type === 'delivery' ? '' : stores[storeId];
  if (type !== 'delivery' && !storeName) return { ok: false, error: '請選擇取餐門市' };

  // --- 2. 防止重複送出：同一支手機 20 秒內只接受一筆 ---
  const cache = CacheService.getScriptCache();
  const dupKey = 'order_' + phone;
  if (cache.get(dupKey)) return { ok: false, error: '訂單已送出，請勿重複點擊' };

  // --- 3. 以「商品」工作表價格重新計算 ---
  const products = getProducts_();
  const lines = [];
  let subtotal = 0;
  for (const it of items) {
    const p = products[String(it.id)];
    const qty = Math.floor(Number(it.qty));
    if (!p) return { ok: false, error: '商品已下架或不存在：' + it.id };
    if (!(qty >= 1 && qty <= 99)) return { ok: false, error: '商品數量不正確' };
    const amount = p.price * qty;
    subtotal += amount;
    lines.push({ id: String(it.id), name: p.name, price: p.price, qty: qty, amount: amount });
  }
  const shipFee = Number(settings['宅配運費']) || 0;
  const freeAt = Number(settings['免運門檻']) || Infinity;
  const shipping = type === 'delivery' && subtotal < freeAt ? shipFee : 0;
  const total = subtotal + shipping;

  // --- 4. 加鎖產生流水號並寫入 ---
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  let orderNo, createdAt;
  try {
    const ss = SpreadsheetApp.getActive();
    const ordersSheet = ss.getSheetByName(SHEET.ORDERS);
    const itemsSheet = ss.getSheetByName(SHEET.ITEMS);
    if (!ordersSheet || !itemsSheet) throw new Error('尚未執行 setup()');

    createdAt = new Date();
    orderNo = nextOrderNo_(createdAt);
    const summary = lines.map(l => l.name + '×' + l.qty).join('、');

    ordersSheet.appendRow([orderNo, createdAt, '新訂單', TYPE_LABEL[type], storeName || '—', name, "'" + phone,
      address, note, summary, subtotal, shipping, total, '官網']);
    itemsSheet.getRange(itemsSheet.getLastRow() + 1, 1, lines.length, ITEM_HEADERS.length)
      .setValues(lines.map(l => [orderNo, createdAt, l.id, l.name, l.price, l.qty, l.amount]));
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  cache.put(dupKey, '1', 20);

  // --- 5. 通知店家（失敗不影響訂單成立） ---
  if (settings['寄送新訂單通知'] !== '否') {
    try { notifyNewOrder_(settings, { orderNo, createdAt, type, storeName, name, phone, address, note, lines, subtotal, shipping, total }); }
    catch (err) { console.error('通知寄送失敗', err); }
  }

  return { ok: true, orderNo: orderNo, subtotal: subtotal, shipping: shipping, total: total };
}

/** 每日流水號：HJ + yyMMdd + - + 4 碼，例如 HJ261127-0001 */
function nextOrderNo_(date) {
  const day = Utilities.formatDate(date, TZ, 'yyMMdd');
  const props = PropertiesService.getScriptProperties();
  const key = 'seq_' + day;
  const seq = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(seq));
  return 'HJ' + day + '-' + String(seq).padStart(4, '0');
}

/* ============================== 查詢訂單 ============================== */

function lookupOrder_(orderNo, phone) {
  orderNo = String(orderNo || '').trim().toUpperCase();
  phone = String(phone || '').replace(/[\s-]/g, '');
  if (!orderNo || !phone) return { ok: false, error: '請提供訂單編號與手機號碼' };
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET.ORDERS);
  const rows = sheet.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 1; i--) {
    if (rows[i][0] === orderNo && String(rows[i][6]).replace(/^'/, '') === phone) {
      return { ok: true, orderNo: orderNo, status: rows[i][2], type: rows[i][3], total: rows[i][12] };
    }
  }
  return { ok: false, error: '查無此訂單' };
}

/* ============================== Email 通知 ============================== */

function notifyNewOrder_(settings, o) {
  const to = String(settings['通知Email'] || '').trim() || Session.getEffectiveUser().getEmail();
  if (!to) return;
  const rows = o.lines.map(l => `<tr><td>${esc_(l.name)}</td><td align="right">${l.qty}</td><td align="right">${money_(l.amount)}</td></tr>`).join('');
  const where = o.type === 'delivery' ? '宅配地址：' + esc_(o.address) : '門市：' + esc_(o.storeName);
  const html = `
    <div style="font-family:sans-serif;color:#3B2A20">
      <h2 style="color:#D9752B;margin:0 0 8px">新訂單 ${o.orderNo}</h2>
      <p>${TYPE_LABEL[o.type]}｜${where}<br>顧客：${esc_(o.name)}　${o.phone}<br>
      時間：${Utilities.formatDate(o.createdAt, TZ, 'yyyy/MM/dd HH:mm')}</p>
      <table cellpadding="6" style="border-collapse:collapse;border:1px solid #E2D3BE">
        <tr style="background:#F8F2E9"><th align="left">商品</th><th>數量</th><th>金額</th></tr>${rows}
        <tr><td colspan="2">小計</td><td align="right">${money_(o.subtotal)}</td></tr>
        <tr><td colspan="2">運費</td><td align="right">${money_(o.shipping)}</td></tr>
        <tr style="font-weight:bold"><td colspan="2">總額</td><td align="right">${money_(o.total)}</td></tr>
      </table>
      ${o.note ? `<p>備註：${esc_(o.note)}</p>` : ''}
      <p><a href="${SpreadsheetApp.getActive().getUrl()}">開啟訂單試算表</a></p>
    </div>`;
  MailApp.sendEmail({ to: to, subject: `【禾煎】新訂單 ${o.orderNo}｜${TYPE_LABEL[o.type]}｜${money_(o.total)}`, htmlBody: html });
}

/* ============================== 每日營業報表 ============================== */

/** 建立（或重建）每日報表排程，依「設定」工作表的「每日報表時間」 */
function installDailyReport() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sendDailyReport')
    .forEach(t => ScriptApp.deleteTrigger(t));
  const hour = Math.min(23, Math.max(0, Number(getSettings_()['每日報表時間']) || 21));
  ScriptApp.newTrigger('sendDailyReport').timeBased().everyDays(1).atHour(hour).inTimezone(TZ).create();
  SpreadsheetApp.getActive().toast(`已設定每天 ${hour}:00 左右寄出當日營業報表`, '禾煎', 6);
}

function sendDailyReport() {
  const settings = getSettings_();
  const to = String(settings['通知Email'] || '').trim() || Session.getEffectiveUser().getEmail();
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd');
  const rows = SpreadsheetApp.getActive().getSheetByName(SHEET.ORDERS).getDataRange().getValues().slice(1)
    .filter(r => r[1] instanceof Date && Utilities.formatDate(r[1], TZ, 'yyyy/MM/dd') === today && r[2] !== '已取消');

  const byType = {}, byStore = {};
  let revenue = 0;
  rows.forEach(r => {
    revenue += Number(r[12]) || 0;
    byType[r[3]] = (byType[r[3]] || 0) + 1;
    byStore[r[4]] = (byStore[r[4]] || 0) + (Number(r[12]) || 0);
  });
  const list = obj => Object.keys(obj).map(k => `<li>${esc_(k)}：${obj[k]}</li>`).join('') || '<li>—</li>';
  const html = `
    <div style="font-family:sans-serif;color:#3B2A20">
      <h2 style="color:#D9752B">禾煎 ${today} 營業摘要</h2>
      <p>有效訂單：<b>${rows.length}</b> 筆　營收：<b>${money_(revenue)}</b></p>
      <p>取餐方式（筆數）</p><ul>${list(byType)}</ul>
      <p>各門市營收（NT$）</p><ul>${list(byStore)}</ul>
    </div>`;
  MailApp.sendEmail({ to: to, subject: `【禾煎】${today} 營業摘要｜${rows.length} 筆｜${money_(revenue)}`, htmlBody: html });
}

/* ============================== 試算表選單與初始化 ============================== */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('禾煎訂單')
    .addItem('初始化／修復工作表', 'setup')
    .addItem('設定每日營業報表', 'installDailyReport')
    .addItem('立即寄出今日報表', 'sendDailyReport')
    .addToUi();
}

/** 第一次使用請執行：建立所有工作表、標題、格式、下拉選單與預設資料（可重複執行，不會覆蓋既有資料） */
function setup() {
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);

  const orders = ensureSheet_(ss, SHEET.ORDERS, ORDER_HEADERS);
  orders.getRange('B:B').setNumberFormat('yyyy/mm/dd hh:mm');
  orders.getRange('K:M').setNumberFormat('"NT$"#,##0');
  orders.setColumnWidth(10, 280);
  const statusRule = SpreadsheetApp.newDataValidation().requireValueInList(STATUS_LIST, true).build();
  orders.getRange(2, 3, orders.getMaxRows() - 1, 1).setDataValidation(statusRule);
  const colors = { '新訂單': '#FDE7D3', '製作中': '#FFF4C2', '可取餐': '#DFF3E3', '已出貨': '#DCEBFA', '已完成': '#EEEEEE', '已取消': '#F8D7DA' };
  orders.setConditionalFormatRules(Object.keys(colors).map(s =>
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(s).setBackground(colors[s])
      .setRanges([orders.getRange('C2:C')]).build()));

  const items = ensureSheet_(ss, SHEET.ITEMS, ITEM_HEADERS);
  items.getRange('B:B').setNumberFormat('yyyy/mm/dd hh:mm');
  items.getRange('E:E').setNumberFormat('"NT$"#,##0');
  items.getRange('G:G').setNumberFormat('"NT$"#,##0');

  const products = ensureSheet_(ss, SHEET.PRODUCTS, ['商品編號', '商品名稱', '售價', '上架']);
  if (products.getLastRow() < 2) {
    products.getRange(2, 1, DEFAULT_PRODUCTS.length, 4).setValues(DEFAULT_PRODUCTS.map(p => p.concat(['是'])));
  }
  products.getRange('C:C').setNumberFormat('"NT$"#,##0');
  products.getRange(2, 4, products.getMaxRows() - 1, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['是', '否'], true).build());

  const stores = ensureSheet_(ss, SHEET.STORES, ['門市代碼', '門市名稱']);
  if (stores.getLastRow() < 2) stores.getRange(2, 1, DEFAULT_STORES.length, 2).setValues(DEFAULT_STORES);

  const settings = ensureSheet_(ss, SHEET.SETTINGS, ['項目', '值', '說明']);
  const existing = settings.getLastRow() > 1 ? settings.getRange(2, 1, settings.getLastRow() - 1, 1).getValues().flat() : [];
  DEFAULT_SETTINGS.filter(s => existing.indexOf(s[0]) < 0).forEach(s => settings.appendRow(s));
  settings.setColumnWidth(3, 360);

  const blank = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  ss.setActiveSheet(orders);
  ss.toast('工作表已建立完成，接著請部署為網頁應用程式。', '禾煎', 6);
}

function ensureSheet_(ss, name, headers) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#3B2A20').setFontColor('#F8F2E9');
  sh.setFrozenRows(1);
  return sh;
}

/* ============================== 工具函式 ============================== */

function getProducts_() {
  const rows = SpreadsheetApp.getActive().getSheetByName(SHEET.PRODUCTS).getDataRange().getValues().slice(1);
  const map = {};
  rows.forEach(r => { if (r[0] && r[3] !== '否') map[String(r[0])] = { name: String(r[1]), price: Number(r[2]) }; });
  return map;
}

function getMap_(sheetName) {
  const rows = SpreadsheetApp.getActive().getSheetByName(sheetName).getDataRange().getValues().slice(1);
  const map = {};
  rows.forEach(r => { if (r[0]) map[String(r[0])] = String(r[1]); });
  return map;
}

function getSettings_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.SETTINGS);
  const map = {};
  if (sh) sh.getDataRange().getValues().slice(1).forEach(r => { if (r[0]) map[String(r[0])] = r[1]; });
  return map;
}

function clean_(v, max) { return String(v || '').replace(/[\u0000-\u001f]/g, ' ').replace(/^[=+\-@]/, "'$&").trim().slice(0, max); }
function esc_(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function money_(n) { return 'NT$' + Number(n || 0).toLocaleString('en-US'); }
function now_() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
