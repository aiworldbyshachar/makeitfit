// Every string the page shows. English only for now (decided 2026-11-11); the shape is ready for more
// languages: add one to LANGUAGES and a table to STRINGS, and the test checks it has every key.
//
// "{name}" is replaced with a value. A message given as an object is picked by plural form ({n}).
// Keys ending in "Html" may hold simple markup (<b>, <em>) and are set as HTML; all others as text.
// Short hyphens only - never em or en dashes.

export const LANGUAGES = [{ code: 'en', name: 'English', dir: 'ltr' }];

export const STRINGS = {
  en: {
    pageTitle: 'MakeItFit - make photos and PDFs fit the size limit',
    pageDescription: 'Drop photos or PDFs, type the size limit, get one file that fits. Free, private, made in your browser - nothing is uploaded.',
    headingHtml: 'Make the file <em>fit</em>.',
    lead: 'Drop photos or PDFs, type the size limit, and get one file that fits. It all happens in your browser - nothing is uploaded.',

    limitLabel: 'Under',
    limitUnit: 'MB',
    limitAria: 'Size limit in MB',
    limitQuick: 'Common limits',
    limitBad: 'Type a size, like 2 or 2.5',

    dropTitle: 'Drop photos or PDFs here',
    choose: 'Choose files',
    takePhoto: 'Take a photo',
    addMore: 'Add more',
    privacy: 'Your files never leave this device',
    offline: 'Works offline',
    oneRuleHtml: '<b>The one rule:</b> photos and PDFs only (JPG, PNG, HEIC, WebP, PDF).',

    pages: { one: '1 page', other: '{n} pages' },
    reading: 'Reading...',
    protectedBadge: 'Password-protected',
    damagedBadge: "Can't be read",
    moveUp: 'Move up',
    moveDown: 'Move down',
    rotate: 'Rotate',
    remove: 'Remove',
    total: 'Total {size}',
    fitsAlready: 'Already fits',
    timesOver: '{x} times over the limit',

    outputLabel: 'Make',
    outPdf: 'One PDF',
    outSeparate: 'Separate files',
    outJpg: 'JPG',
    jpgOnlyOne: 'JPG is for one photo. For several files, pick One PDF or Separate files.',
    go: 'Make it fit',

    stageRead: 'Reading your files',
    stagePhotos: 'Finding the best quality that fits',
    stageBuild: 'Making the file',
    stagePdf: 'Shrinking the photos inside the PDF',
    stagePages: 'Turning the pages into images',
    stageSplit: 'Making the parts',
    cancel: 'Cancel',

    resultFits: '{size} - fits under {limit}',
    resultExact: '{bytes} bytes',
    resultUnchanged: 'Already fits under {limit} - here it is, unchanged.',
    resultParts: { one: '1 file, under {limit}', other: '{n} files, each under {limit}' },
    resultPartPages: { one: 'page {from}', other: 'pages {from}-{to}' },
    textIsImage: 'The pages are now images, so the text can\'t be selected. That is fine for uploading.',
    notFitted: "{name} couldn't fit readably - the smallest readable size is {size}.",
    morePages: { one: '+1 more page', other: '+{n} more pages' },
    download: 'Download',
    share: 'Share',
    shareAll: 'Share all',
    startOver: 'Start over',

    askTitle: 'Turn the pages into images?',
    askBody: "Shrinking the photos inside isn't enough to reach {limit}. The pages can become images: they look the same, but the text can't be selected.",
    askYes: 'Turn pages into images',
    askSplit: 'Split instead, keep the text',

    cantTitle: "It can't fit {limit} and stay readable",
    cantBody: 'The smallest readable size is {size}.',
    cantSplitBody: { one: 'It can be split into 1 file under {limit}.', other: 'It can be split into {n} files, each under {limit}.' },
    cantSplit: { one: 'Split into 1 file', other: 'Split into {n} files' },
    cantBigger: 'Change the limit',

    errUnsupported: { one: "{names} isn't a photo or a PDF - MakeItFit works with photos and PDFs only.", other: "{names} aren't photos or PDFs - MakeItFit works with photos and PDFs only." },
    errProtected: '{names} is protected with a password. Open it, save a copy without the password, and try again.',
    errGeneric: 'Something went wrong: {message}',

    github: 'GitHub',
    githubLong: 'Source on ',
    support: 'Support',
    footerFree: 'Free and open source (MIT)',
    footerBy: 'By AI World by Shachar',
    moreTools: 'More free tools',
  },
};

export function createTranslator(lang) {
  const info = LANGUAGES.find((l) => l.code === lang) || LANGUAGES[0];
  const table = STRINGS[info.code];
  const numbers = new Intl.NumberFormat(info.code);
  const plurals = new Intl.PluralRules(info.code);

  function t(key, vars) {
    let msg = key in table ? table[key] : key in STRINGS.en ? STRINGS.en[key] : key;
    if (msg && typeof msg === 'object') {
      const n = vars ? Number(vars.n) : 0;
      msg = (n === 0 && msg.zero) || msg[plurals.select(n)] || msg.other;
    }
    if (!vars) return msg;
    return msg.replace(/\{(\w+)\}/g, (m, name) => {
      if (!(name in vars)) return m;
      if (name === 'n') return numbers.format(vars.n);
      // In right-to-left languages a Latin value (a file name, a size) is isolated so it doesn't pull
      // the punctuation around it out of place.
      return info.dir === 'rtl' ? `⁨${vars[name]}⁩` : String(vars[name]);
    });
  }

  /** Fills every [data-i18n] (text) and [data-i18n-html] (markup) element, and [data-i18n-*] attributes. */
  function apply(root) {
    root.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
    root.querySelectorAll('[data-i18n-html]').forEach((el) => (el.innerHTML = t(el.dataset.i18nHtml)));
    root.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
    root.querySelectorAll('[data-i18n-title]').forEach((el) => el.setAttribute('title', t(el.dataset.i18nTitle)));
  }

  return { code: info.code, dir: info.dir, t, apply };
}
