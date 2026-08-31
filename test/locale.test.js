import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseSource } from '../dist/engine.js';
import { ALL_RULES } from '../dist/rules/index.js';

/**
 * A correct page is correct in every language.
 *
 * This file exists because of one character class. The placeholder-alt rule asked whether
 * an alt contained letters, and asked it with `[^A-Za-z]`, so a careful Russian
 * description was reported as carrying no information — 649 invented findings on one
 * museum's site, in the language the tool is being sold into. Two hundred and twenty-seven
 * tests and five Western repositories could not have caught it: not one of them contains a
 * word that is not Latin.
 *
 * So the guard is a page built correctly, written out once per writing system, asserted to
 * produce nothing. It is deliberately dull markup — a heading, a table with headers, a
 * labelled form, images with real descriptions — because the claim under test is not about
 * any rule in particular. It is that no rule mistakes an unfamiliar alphabet for an absence
 * of text.
 */

const CLEAN = (p) => `<!DOCTYPE html>
<html lang="${p.lang}"${p.dir === undefined ? '' : ` dir="${p.dir}"`}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${p.title}</title>
</head>
<body style="background:#ffffff;color:#1a1a1a">
  <a href="#main">${p.skip}</a>
  <header>
    <img src="/logo.svg" alt="${p.alt1}">
    <nav aria-label="${p.nav}">
      <ul><li><a href="/a/">${p.nav}</a></li></ul>
    </nav>
  </header>
  <main id="main">
    <h1>${p.heading}</h1>
    <p style="font-size:16px">${p.body}</p>
    <img src="/hall.jpg" alt="${p.alt2}">
    <table>
      <caption>${p.caption}</caption>
      <thead><tr><th scope="col">${p.th1}</th><th scope="col">${p.th2}</th></tr></thead>
      <tbody><tr><td>${p.c1}</td><td>${p.c2}</td></tr></tbody>
    </table>
    <form action="/booking" method="post">
      <label for="who">${p.label1}</label>
      <input type="text" id="who" name="who" autocomplete="name">
      <label for="mail">${p.label2}</label>
      <input type="email" id="mail" name="email" autocomplete="email">
      <button type="submit">${p.submit}</button>
    </form>
    <p><a href="/p.pdf" target="_blank" rel="noopener">${p.linkText}</a></p>
  </main>
</body>
</html>`;

const PAGES = {
  Russian: {
    lang: 'ru',
    title: 'Государственный музей — Расписание экскурсий',
    skip: 'Перейти к основному содержанию',
    alt1: 'Герб музея: двуглавый орёл на красном щите',
    alt2: 'Парадные сени музея с расписным сводом',
    heading: 'Расписание экскурсий на декабрь',
    body: 'Экскурсии проводятся ежедневно, кроме понедельника.',
    nav: 'Выставки и экскурсии',
    th1: 'День',
    th2: 'Время',
    c1: 'Вторник',
    c2: '11:00',
    label1: 'Фамилия, имя и отчество',
    label2: 'Электронная почта',
    submit: 'Отправить заявку',
    caption: 'Время начала экскурсий',
    linkText: 'Программа на декабрь (PDF, откроется в новой вкладке)',
  },
  Greek: {
    lang: 'el',
    title: 'Εθνικό Μουσείο — Πρόγραμμα ξεναγήσεων',
    skip: 'Μετάβαση στο κύριο περιεχόμενο',
    alt1: 'Το έμβλημα του μουσείου: γλαύκα σε γαλάζια ασπίδα',
    alt2: 'Η κεντρική αίθουσα με τοιχογραφίες του 1883',
    heading: 'Πρόγραμμα ξεναγήσεων Δεκεμβρίου',
    body: 'Οι ξεναγήσεις γίνονται καθημερινά εκτός Δευτέρας.',
    nav: 'Εκθέσεις και ξεναγήσεις',
    th1: 'Ημέρα',
    th2: 'Ώρα',
    c1: 'Τρίτη',
    c2: '11:00',
    label1: 'Ονοματεπώνυμο',
    label2: 'Ηλεκτρονικό ταχυδρομείο',
    submit: 'Υποβολή αίτησης',
    caption: 'Ώρες έναρξης ξεναγήσεων',
    linkText: 'Πρόγραμμα Δεκεμβρίου (PDF, ανοίγει σε νέα καρτέλα)',
  },
  Chinese: {
    lang: 'zh',
    title: '国家博物馆 — 导览时间表',
    skip: '跳到主要内容',
    alt1: '博物馆徽章：红色盾牌上的双头鹰',
    alt2: '博物馆正厅，一八八三年绘制的穹顶',
    heading: '十二月导览时间表',
    body: '除星期一外，每天均有导览。',
    nav: '展览与导览',
    th1: '日期',
    th2: '时间',
    c1: '星期二',
    c2: '11:00',
    label1: '姓名',
    label2: '电子邮箱',
    submit: '提交申请',
    caption: '导览开始时间',
    linkText: '十二月导览手册（PDF，在新标签页中打开）',
  },
  Arabic: {
    lang: 'ar',
    dir: 'rtl',
    title: 'المتحف الوطني — جدول الجولات',
    skip: 'انتقل إلى المحتوى الرئيسي',
    alt1: 'شعار المتحف: نسر برأسين على درع أحمر',
    alt2: 'القاعة الرئيسية بقبتها المزخرفة',
    heading: 'جدول الجولات لشهر ديسمبر',
    body: 'تنظم الجولات يوميا ما عدا يوم الاثنين.',
    nav: 'المعارض والجولات',
    th1: 'اليوم',
    th2: 'الوقت',
    c1: 'الثلاثاء',
    c2: '11:00',
    label1: 'الاسم الكامل',
    label2: 'البريد الإلكتروني',
    submit: 'إرسال الطلب',
    caption: 'مواعيد بدء الجولات',
    linkText: 'برنامج ديسمبر (PDF، يفتح في تبويب جديد)',
  },
  Hebrew: {
    lang: 'he',
    dir: 'rtl',
    title: 'המוזיאון הלאומי — לוח הסיורים',
    skip: 'דלג לתוכן הראשי',
    alt1: 'סמל המוזיאון: נשר דו-ראשי על מגן אדום',
    alt2: 'האולם המרכזי והכיפה המצוירת',
    heading: 'לוח הסיורים לדצמבר',
    body: 'הסיורים מתקיימים מדי יום למעט יום שני.',
    nav: 'תערוכות וסיורים',
    th1: 'יום',
    th2: 'שעה',
    c1: 'שלישי',
    c2: '11:00',
    label1: 'שם מלא',
    label2: 'דואר אלקטרוני',
    submit: 'שליחת בקשה',
    caption: 'שעות תחילת הסיורים',
    linkText: 'תוכנית דצמבר (PDF, נפתח בלשונית חדשה)',
  },
  Japanese: {
    lang: 'ja',
    title: '国立博物館 — ガイドツアーの時間',
    skip: 'メインコンテンツへ移動',
    alt1: '博物館の紋章：赤い盾に描かれた双頭の鷲',
    alt2: '一八八三年に描かれた天井をもつ大広間',
    heading: '十二月のガイドツアー予定',
    body: '月曜日を除き毎日ガイドツアーを行っています。',
    nav: '展覧会とツアー',
    th1: '曜日',
    th2: '時刻',
    c1: '火曜日',
    c2: '11:00',
    label1: '氏名',
    label2: 'メールアドレス',
    submit: '申し込む',
    caption: 'ツアー開始時刻',
    linkText: '十二月のプログラム（PDF、新しいタブで開きます）',
  },
  Georgian: {
    lang: 'ka',
    title: 'ეროვნული მუზეუმი — ექსკურსიების განრიგი',
    skip: 'ძირითად შიგთავსზე გადასვლა',
    alt1: 'მუზეუმის ემბლემა: ორთავიანი არწივი წითელ ფარზე',
    alt2: 'მთავარი დარბაზი მოხატული კამარით',
    heading: 'დეკემბრის ექსკურსიების განრიგი',
    body: 'ექსკურსიები ტარდება ყოველდღე, ორშაბათის გარდა.',
    nav: 'გამოფენები და ექსკურსიები',
    th1: 'დღე',
    th2: 'დრო',
    c1: 'სამშაბათი',
    c2: '11:00',
    label1: 'სახელი და გვარი',
    label2: 'ელექტრონული ფოსტა',
    submit: 'განაცხადის გაგზავნა',
    caption: 'ექსკურსიების დაწყების დრო',
    linkText: 'დეკემბრის პროგრამა (PDF, გაიხსნება ახალ ჩანართში)',
  },
};

test('a correctly built page produces nothing, in every writing system', () => {
  for (const [name, page] of Object.entries(PAGES)) {
    const result = analyseSource('page.html', CLEAN(page), {
      rules: ALL_RULES,
      level: 'AA',
      fixThreshold: null,
    });
    assert.deepEqual(
      result.violations.map((v) => `${v.ruleId}: ${v.message}`),
      [],
      `${name} page produced findings`,
    );
  }
});

test('the same page with the faults put back is still caught, in every writing system', () => {
  // The other half of the claim. A test that only proved silence would also pass with
  // every rule switched off, so each page is broken in four specific ways and each break
  // has to come back.
  for (const [name, page] of Object.entries(PAGES)) {
    const broken = CLEAN(page)
      .replace(` alt="${page.alt2}"`, '')
      .replace(`<label for="who">${page.label1}</label>`, '')
      .replace(`<html lang="${page.lang}"`, '<html')
      .replace(`>${page.submit}</button>`, '></button>');
    const ids = new Set(
      analyseSource('page.html', broken, {
        rules: ALL_RULES,
        level: 'AA',
        fixThreshold: null,
      }).violations.map((v) => v.ruleId),
    );
    for (const id of ['A11Y-IMG-001', 'A11Y-FORM-001', 'A11Y-DOC-001', 'A11Y-FORM-004']) {
      assert.ok(ids.has(id), `${name}: ${id} was not reported on a page that has that fault`);
    }
  }
});

/**
 * The vocabulary tables have to survive the same normalisation the page text does.
 *
 * `normalizeText` decomposes to NFD and strips combining marks, which turns «й» into «и»
 * and «ё» into «е». Page text went through it and the tables did not, so every entry
 * containing either letter was unreachable: «перейти» could not match «Перейти», and
 * «новой вкладке» could not match a link that announced the new tab in exactly those
 * words — a false positive, not merely a miss.
 */

const runRu = (body) =>
  analyseSource(
    'page.html',
    `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Тест</title></head>` +
      `<body><main><h1>Заголовок</h1>${body}</main></body></html>`,
    { rules: ALL_RULES, level: 'AA', fixThreshold: null },
  ).violations;

test('generic link text spelled with й is recognised', () => {
  const found = runRu('<a href="/x/">Перейти</a>').filter((v) => v.ruleId === 'A11Y-LINK-002');
  assert.equal(found.length, 1, '«Перейти» is as empty a link name as «click here»');
});

test('the same entries still match after the ё-to-е collapse', () => {
  for (const text of ['Ещё', 'Еще', 'Подробнее', 'Читать далее']) {
    assert.equal(
      runRu(`<a href="/x/">${text}</a>`).filter((v) => v.ruleId === 'A11Y-LINK-002').length,
      1,
      `${text} should be recognised however it is spelled`,
    );
  }
});

test('a link that announces its new tab in Russian is not accused of hiding it', () => {
  for (const text of [
    'Отчёт (откроется в новой вкладке)',
    'Архив — откроется в новом окне',
    'Каталог, другой сайт',
  ]) {
    assert.equal(
      runRu(`<a href="/x/" target="_blank">${text}</a>`).filter((v) => v.ruleId === 'A11Y-LINK-005')
        .length,
      0,
      `${text} says the thing the rule asks for`,
    );
  }
});

test('and one that says nothing about it still is', () => {
  const found = runRu('<a href="/x/" target="_blank">Отчёт за 2025 год</a>');
  assert.equal(found.filter((v) => v.ruleId === 'A11Y-LINK-005').length, 1);
});


/**
 * A11Y-FORM-008 reads the page, not the file.
 *
 * Two faults in one line. The legend it looked for was English-only, so a Russian form
 * saying «* — обязательные поля» directly above the field was told its asterisk was
 * unexplained. And it looked for that legend in the raw source, where a CSS attribute
 * selector — `[class*="cell"]` in a single inline <style> — matches the "* =" form and
 * switched the rule off for the whole document. Five of the ninety-two audited pages did
 * exactly that, and the symptom was silence, which is why nobody noticed.
 */

const asteriskForm = (legend, head = '') =>
  analyseSource(
    'page.html',
    `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Тест</title>${head}</head>` +
      `<body><main><h1>Заголовок</h1><form><p>${legend}</p>` +
      `<label for="a">Имя *</label><input id="a" required>` +
      `<button type="submit">Отправить</button></form></main></body></html>`,
    { rules: ALL_RULES, level: 'AA', fixThreshold: null },
  ).violations.filter((v) => v.ruleId === 'A11Y-FORM-008');

test('a Russian legend explains the asterisk', () => {
  for (const legend of [
    '* — обязательные поля',
    'Поля, отмеченные *, обязательны для заполнения',
    'Звёздочкой отмечены обязательные поля',
    'Звездочкой отмечены обязательные поля',
    '* — поле, обязательное к заполнению',
  ]) {
    assert.equal(asteriskForm(legend).length, 0, `«${legend}» explains it`);
  }
});

test('a form with no legend at all is still reported', () => {
  assert.equal(asteriskForm('Заполните форму').length, 1);
});

test('a stylesheet selector is not an explanation anybody can read', () => {
  assert.equal(
    asteriskForm('Заполните форму', '<style>[class*="cell"]{color:red}</style>').length,
    1,
    'the * = in a CSS attribute selector must not count as a legend',
  );
});


/**
 * A link is named by the image inside it.
 *
 * `<a href="…"><img alt="Алмазная колесница"></a>` is named by that alt — that is the
 * accessible name computation, and it is how the front page of nearly every museum in
 * the corpus names its slider links. Reading only the text made all of them nameless, so
 * every rule that needs a name to say anything fell silent on exactly those links.
 */

const linkFindings = (body) =>
  analyseSource(
    'page.html',
    `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Тест</title></head>` +
      `<body><main><h1>Заголовок</h1>${body}</main></body></html>`,
    { rules: ALL_RULES, level: 'AA', fixThreshold: null },
  ).violations;

test('a link whose only content is an image takes the image name', () => {
  const found = linkFindings(
    '<a href="/a/" target="_blank"><img src="a.jpg" alt="Алмазная колесница"></a>',
  );
  const newWindow = found.filter((v) => v.ruleId === 'A11Y-LINK-005');
  assert.equal(newWindow.length, 1, 'the link has a name, and that name says nothing about a new tab');
  assert.match(newWindow[0].message, /Алмазная колесница/);
  assert.equal(
    found.filter((v) => v.ruleId === 'A11Y-LINK-001').length,
    0,
    'and it is not also reported as having no name at all',
  );
});

test('two image links with one alt and two destinations are ambiguous', () => {
  // meloman.ru serves thirty-one of these: «Изображение слайдера» thirty-one times, to
  // thirty-one different concerts. Someone listening to a list of links hears one phrase.
  const found = linkFindings(
    '<a href="/a/"><img src="a.jpg" alt="Изображение слайдера"></a>' +
      '<a href="/b/"><img src="b.jpg" alt="Изображение слайдера"></a>',
  );
  assert.ok(found.some((v) => v.ruleId === 'A11Y-LINK-006'));
});

test('an image whose alt is an expression makes the name unreadable, not absent', () => {
  const found = analyseSource(
    'page.jsx',
    '<a href="/a/" target="_blank"><img src="a.jpg" alt={caption} /></a>',
    { rules: ALL_RULES, level: 'AA', fixThreshold: null },
  ).violations;
  assert.equal(
    found.filter((v) => v.ruleId === 'A11Y-LINK-005' || v.ruleId === 'A11Y-LINK-001').length,
    0,
    'a finding about a name we could not read is the one kind that must not be produced',
  );
});

test('a link hidden from assistive technology is not judged on its name', () => {
  // mxat.ru puts a decorative duplicate beside every visible show link: aria-hidden and
  // out of the tab order, correct as written. A11Y-KBD-004 covers the case that is not.
  for (const attrs of [
    'aria-hidden="true" tabindex="-1" target="_blank"',
    'hidden target="_blank"',
  ]) {
    const found = linkFindings(`<a href="/a/" ${attrs}><img src="a.jpg" alt="Школа"></a>`);
    assert.equal(
      found.filter((v) => v.ruleId.startsWith('A11Y-LINK-00')).filter((v) => v.ruleId !== 'A11Y-LINK-004').length,
      0,
      `${attrs} should silence the naming rules`,
    );
  }
});

test('an aria-hidden ancestor hides the link inside it', () => {
  const found = linkFindings(
    '<div aria-hidden="true"><a href="/a/" target="_blank"><img src="a.jpg" alt="Школа"></a></div>',
  );
  assert.equal(found.filter((v) => v.ruleId === 'A11Y-LINK-005').length, 0);
});

test('aria-hidden="false" does not hide anything', () => {
  const found = linkFindings(
    '<a href="/a/" aria-hidden="false" target="_blank"><img src="a.jpg" alt="Школа"></a>',
  );
  assert.equal(found.filter((v) => v.ruleId === 'A11Y-LINK-005').length, 1);
});
