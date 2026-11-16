'use strict';

function isValidIsoDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    if (year < 1 || month < 1 || month > 12) return false;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day >= 1 && day <= days[month - 1];
}

function formatLocalDate(date) {
    const pad = value => String(value).padStart(2, '0');
    return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatLocalDateTime(date, includeSeconds = false) {
    const pad = value => String(value).padStart(2, '0');
    return `${formatLocalDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}${includeSeconds ? `:${pad(date.getSeconds())}` : ''}`;
}
