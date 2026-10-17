"use strict";
// UI translations. The language follows the system unless the user picks one (prefs.lang).
// English strings double as the fallback for any key missing from another language.
(function (root) {
  const LANGS = { en: "English", "zh-TW": "繁體中文" };

  const STRINGS = {
    en: {
      title: "Currency Converter",
      install: "Install",
      theme: "Theme",
      language: "Language",
      system: "System",
      light: "Light",
      dark: "Dark",
      loadingRates: "Loading rates…",
      refreshRates: "Refresh rates",
      edit: "Edit",
      done: "Done",
      addCurrency: "+ Add currency",
      searchCurrencies: "Search currencies",
      keypad: "Calculator keypad",
      clear: "Clear",
      openParen: "Open parenthesis",
      closeParen: "Close parenthesis",
      divide: "Divide",
      times: "Times",
      minus: "Minus",
      plus: "Plus",
      decimal: "Decimal point",
      backspace: "Backspace",
      equals: "Equals",
      moveUp: "Move up",
      moveDown: "Move down",
      remove: "Remove",
      empty: "No currencies selected. Add one below.",
      amountIn: "Amount in {code}",
      unavailable: "unavailable",
      justNow: "just now",
      minAgo: "{n} min ago",
      offlineNoCache: "Offline — no cached rates yet",
      updated: "Updated {when}",
      offlineFrom: "Offline · rates from {time}",
      mayBeOld: "may be out of date",
      ratesUpdatedAt: "Rates updated {when}",
      ratesVia: "Rates via {sources} · refreshed every {n} min",
      srcCache: "cache",
    },
    "zh-TW": {
      title: "匯率換算",
      install: "安裝",
      theme: "主題",
      language: "語言",
      system: "跟隨系統",
      light: "淺色",
      dark: "深色",
      loadingRates: "正在載入匯率…",
      refreshRates: "重新整理匯率",
      edit: "編輯",
      done: "完成",
      addCurrency: "+ 新增貨幣",
      searchCurrencies: "搜尋貨幣",
      keypad: "計算機鍵盤",
      clear: "清除",
      openParen: "左括號",
      closeParen: "右括號",
      divide: "除",
      times: "乘",
      minus: "減",
      plus: "加",
      decimal: "小數點",
      backspace: "退格",
      equals: "等於",
      moveUp: "上移",
      moveDown: "下移",
      remove: "移除",
      empty: "尚未選擇任何貨幣，請在下方新增。",
      amountIn: "{code} 金額",
      unavailable: "無法取得",
      justNow: "剛剛",
      minAgo: "{n} 分鐘前",
      offlineNoCache: "離線中 — 尚無快取匯率",
      updated: "更新於 {when}",
      offlineFrom: "離線中 · 匯率時間 {time}",
      mayBeOld: "可能已過期",
      ratesUpdatedAt: "匯率更新於 {when}",
      ratesVia: "匯率來源：{sources} · 每 {n} 分鐘更新",
      srcCache: "快取",
    },
  };

  const CURRENCY_NAMES = {
    "zh-TW": {
      USD: "美元", EUR: "歐元", JPY: "日圓", GBP: "英鎊", CNY: "人民幣", AUD: "澳幣",
      CAD: "加拿大幣", CHF: "瑞士法郎", HKD: "港幣", SGD: "新加坡幣", SEK: "瑞典克朗",
      KRW: "韓元", NOK: "挪威克朗", NZD: "紐西蘭幣", INR: "印度盧比", MXN: "墨西哥披索",
      TWD: "新台幣", ZAR: "南非蘭特", BRL: "巴西雷亞爾", DKK: "丹麥克朗", PLN: "波蘭茲羅提",
      THB: "泰銖", ILS: "以色列新謝克爾", IDR: "印尼盾", CZK: "捷克克朗", AED: "阿聯迪拉姆",
      TRY: "土耳其里拉", HUF: "匈牙利福林", CLP: "智利披索", SAR: "沙烏地里亞爾",
      PHP: "菲律賓披索", MYR: "馬來西亞令吉", COP: "哥倫比亞披索", VND: "越南盾",
      ARS: "阿根廷披索", EGP: "埃及鎊", PKR: "巴基斯坦盧比", NGN: "奈及利亞奈拉",
      KWD: "科威特第納爾", QAR: "卡達里亞爾", BDT: "孟加拉塔卡", MOP: "澳門幣",
      RON: "羅馬尼亞列伊", PEN: "秘魯索爾", UAH: "烏克蘭格里夫納", RUB: "俄羅斯盧布",
    },
  };

  // Maps a browser language tag to a supported language. Only Traditional Chinese is offered.
  function match(tag) {
    const t = String(tag || "").toLowerCase();
    if (t === "zh-tw" || t === "zh-hk" || t === "zh-mo" || t.startsWith("zh-hant")) return "zh-TW";
    if (t.startsWith("en")) return "en";
    return null;
  }

  function systemLang() {
    const tags = (typeof navigator !== "undefined" && (navigator.languages || [navigator.language])) || [];
    for (const tag of tags) {
      const m = match(tag);
      if (m) return m;
    }
    return "en";
  }

  let choice = "system";
  let current = "en";

  function setChoice(value) {
    choice = value === "en" || value === "zh-TW" ? value : "system";
    current = choice === "system" ? systemLang() : choice;
    if (typeof document !== "undefined") document.documentElement.lang = current;
    return current;
  }

  function t(key, vars) {
    let s = (STRINGS[current] && STRINGS[current][key]) ?? STRINGS.en[key] ?? key;
    if (vars) for (const k in vars) s = s.replaceAll(`{${k}}`, vars[k]);
    return s;
  }

  // Display name for a currency, falling back to the server-provided English name.
  function currencyName(code, fallback) {
    return (CURRENCY_NAMES[current] && CURRENCY_NAMES[current][code]) || fallback || code;
  }

  // data-i18n="key" sets the text; data-i18n-attrs="title:key,aria-label:key" sets attributes.
  function apply(scope) {
    for (const el of scope.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
    for (const el of scope.querySelectorAll("[data-i18n-attrs]")) {
      for (const pair of el.dataset.i18nAttrs.split(",")) {
        const [attr, key] = pair.split(":");
        el.setAttribute(attr.trim(), t(key.trim()));
      }
    }
  }

  const api = {
    LANGS,
    setChoice,
    t,
    apply,
    currencyName,
    get lang() { return current; },
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.I18n = api;
})(typeof self !== "undefined" ? self : this);
