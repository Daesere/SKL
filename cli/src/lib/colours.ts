export const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  grey:   '\x1b[90m',
};
// Usage: c.red + "text" + c.reset
// No external colour library — these five are sufficient.
