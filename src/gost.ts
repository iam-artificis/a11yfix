/**
 * ГОСТ Р 52872-2019 — the Russian national standard for digital accessibility.
 *
 * Why this file exists: in the market this tool is aimed at, the person reading the
 * report is not a developer. They are a procurement officer or a director holding a
 * contract that names ГОСТ Р 52872-2019, and "WCAG 2.2 SC 1.4.3 Contrast (Minimum)"
 * does not appear in that contract. «Критерий 1.4.3 Контрастность (минимальные
 * требования)» does.
 *
 * The mapping is an identity, which is the useful discovery: the standard was written
 * from WCAG 2.1 and keeps its numbering exactly — «Критерий успешного применения 1.1.1:
 * Нетекстовый контент (Уровень А)». So no correspondence has to be invented, and none
 * is. Every title and level below is transcribed from the standard's own text, extracted
 * from the PDF published by the Russian IFAP committee at
 * https://ifap.ru/library/gost/5287219.pdf, and generated rather than typed.
 *
 * Introduced 2020-04-01 by Приказ Росстандарта от 29 августа 2019 г. № 589-ст,
 * replacing ГОСТ Р 52872-2012.
 *
 * Two limits a reader of this file should know:
 *
 *  - The standard is built on WCAG 2.1. The criteria WCAG 2.2 added (2.4.11–2.4.13,
 *    2.5.7, 2.5.8, 3.2.6, 3.3.7–3.3.9) are not in it, and `gost()` returns undefined
 *    for them rather than guessing. Every criterion a11yfix currently cites is present.
 *  - Levels are written with Cyrillic А (U+0410), as the standard writes them. That is
 *    not a mistake to be tidied up: «Уровень АА» in a Russian document is Cyrillic, and
 *    a contract quoting it will be too.
 *
 * Under 162-ФЗ a national standard applies voluntarily and becomes binding where a
 * contract or a technical regulation names it. This file makes no claim about whether
 * it binds anyone.
 */

export interface GostCriterion {
  /** The criterion's title in the standard's own words. */
  readonly title: string;
  /** 'А' | 'АА' | 'ААА', Cyrillic, as printed. */
  readonly level: string;
}

export const GOST_NAME = 'ГОСТ Р 52872-2019';

/** Every success criterion in the standard, keyed by its number — which is WCAG's. */
export const GOST_CRITERIA: Readonly<Record<string, GostCriterion>> = {
  '1.1.1': { title: 'Нетекстовый контент', level: 'А' },
  '1.2.1': { title: 'Только аудио- и только видео (запись)', level: 'А' },
  '1.2.2': { title: 'Титры (запись)', level: 'А' },
  '1.2.3': { title: 'Тифлокомментарий или альтернативная версия (запись)', level: 'А' },
  '1.2.4': { title: 'Титры (прямой эфир)', level: 'АА' },
  '1.2.5': { title: 'Тифлокомментарий (запись)', level: 'АА' },
  '1.2.6': { title: 'Жестовый язык (запись)', level: 'ААА' },
  '1.2.7': { title: 'Расширенный тифлокомментарий (запись)', level: 'ААА' },
  '1.2.8': { title: 'Альтернативная версия (запись)', level: 'ААА' },
  '1.2.9': { title: 'Только аудио (прямой эфир)', level: 'ААА' },
  '1.3.1': { title: 'Информация и смысловые связи', level: 'А' },
  '1.3.2': { title: 'Значимая последовательность представления контента', level: 'А' },
  '1.3.3': { title: 'Характеристики, воспринимаемые органами чувств', level: 'А' },
  '1.3.4': { title: 'Ориентация', level: 'АА' },
  '1.3.5': { title: 'Указание назначения полей ввода информации', level: 'АА' },
  '1.3.6': { title: 'Указание назначения', level: 'ААА' },
  '1.4.1': { title: 'Использование цвета', level: 'А' },
  '1.4.2': { title: 'Управление аудио', level: 'А' },
  '1.4.3': { title: 'Контрастность (минимальные требования)', level: 'АА' },
  '1.4.4': { title: 'Изменение размера текста', level: 'АА' },
  '1.4.5': { title: 'Графическое представление текста', level: 'АА' },
  '1.4.6': { title: 'Контрастность (расширенные требования)', level: 'ААА' },
  '1.4.7': { title: 'Фоновое аудио, низкая громкость или полное отсутствие звука', level: 'ААА' },
  '1.4.8': { title: 'Визуальное отображение', level: 'ААА' },
  '1.4.9': { title: 'Допустимое графическое представление текста', level: 'ААА' },
  '1.4.10': { title: 'Изменение формата', level: 'АА' },
  '1.4.11': { title: 'Контрастность нетекстовой информации', level: 'АА' },
  '1.4.12': { title: 'Интервалы в тексте', level: 'АА' },
  '1.4.13': { title: 'Контент, отображаемый при наведении указателя или получении клавиатурного фокуса', level: 'АА' },
  '2.1.1': { title: 'Клавиатура', level: 'А' },
  '2.1.2': { title: 'Отсутствие «клавиатурных ловушек»', level: 'А' },
  '2.1.3': { title: 'Клавиатура (без исключений)', level: 'ААА' },
  '2.1.4': { title: 'Клавиши быстрого доступа', level: 'А' },
  '2.2.1': { title: 'Регулировка времени', level: 'А' },
  '2.2.2': { title: 'Пауза, остановка, скрытие', level: 'А' },
  '2.2.3': { title: 'Отсутствие ограничений по времени', level: 'ААА' },
  '2.2.4': { title: 'Прерывания', level: 'ААА' },
  '2.2.5': { title: 'Повторная аутентификация', level: 'ААА' },
  '2.2.6': { title: 'Перерывы', level: 'ААА' },
  '2.3.1': { title: 'Три или менее вспышки', level: 'А' },
  '2.3.2': { title: 'Три вспышки', level: 'ААА' },
  '2.3.3': { title: 'Анимация как результат взаимодействия', level: 'ААА' },
  '2.4.1': { title: 'Пропуск блоков', level: 'А' },
  '2.4.2': { title: 'Заголовок страницы', level: 'А' },
  '2.4.3': { title: 'Перемещение указателя', level: 'А' },
  '2.4.4': { title: 'Цель ссылки (в контексте)', level: 'А' },
  '2.4.5': { title: 'Различные способы', level: 'АА' },
  '2.4.6': { title: 'Заголовки и метки', level: 'АА' },
  '2.4.7': { title: 'Видимый указатель', level: 'АА' },
  '2.4.8': { title: 'Положение', level: 'ААА' },
  '2.4.9': { title: 'Цель ссылки (только ссылка)', level: 'ААА' },
  '2.4.10': { title: 'Заголовки разделов', level: 'ААА' },
  '2.5.1': { title: 'Жесты при работе с указателем', level: 'А' },
  '2.5.2': { title: 'Отмена указателя', level: 'А' },
  '2.5.3': { title: 'Метки в названии', level: 'А' },
  '2.5.4': { title: 'Использование движения', level: 'А' },
  '2.5.5': { title: 'Размер области для наведения указателя', level: 'ААА' },
  '2.5.6': { title: 'Параллельные механизмы ввода', level: 'ААА' },
  '3.1.1': { title: 'Язык страницы', level: 'А' },
  '3.1.2': { title: 'Язык частей контента', level: 'АА' },
  '3.1.3': { title: 'Необычные слова', level: 'ААА' },
  '3.1.4': { title: 'Аббревиатуры', level: 'ААА' },
  '3.1.5': { title: 'Уровень понимания читаемого текста', level: 'ААА' },
  '3.1.6': { title: 'Произношение', level: 'ААА' },
  '3.2.1': { title: 'Наведение указателя', level: 'А' },
  '3.2.2': { title: 'При вводе', level: 'А' },
  '3.2.3': { title: 'Единообразие навигации', level: 'АА' },
  '3.2.4': { title: 'Единообразие определения', level: 'АА' },
  '3.2.5': { title: 'Изменение по запросу', level: 'ААА' },
  '3.3.1': { title: 'Выявление ошибок', level: 'А' },
  '3.3.2': { title: 'Метки или инструкции', level: 'А' },
  '3.3.3': { title: 'Подсказки при ошибках', level: 'АА' },
  '3.3.4': { title: 'Предотвращение ошибок (юридических, финансовых, ввода данных)', level: 'АА' },
  '3.3.5': { title: 'Помощь', level: 'ААА' },
  '3.3.6': { title: 'Предотвращение ошибок (всех)', level: 'ААА' },
  '4.1.1': { title: 'Синтаксис', level: 'А' },
  '4.1.2': { title: 'Название, роль, значение', level: 'А' },
  '4.1.3': { title: 'Статусные сообщения', level: 'АА' },
};

/** The criterion, or undefined for one WCAG 2.2 added after the standard was written. */
export function gost(sc: string): GostCriterion | undefined {
  return GOST_CRITERIA[sc];
}

/**
 * The subsection of the standard the criterion sits in: 1.4.3 is under 4.1.4
 * «Положение 1.4: Различимость». Section 4 is the requirements; its three levels of
 * numbering are principle, guideline, criterion, so the subsection is derivable rather
 * than a second list to keep in step.
 */
export function gostSection(sc: string): string | undefined {
  if (GOST_CRITERIA[sc] === undefined) return undefined;
  const parts = sc.split('.');
  if (parts.length !== 3) return undefined;
  return `4.${parts[0] as string}.${parts[1] as string}`;
}
