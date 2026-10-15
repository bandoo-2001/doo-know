// Keep production entries on the same instance ownership and shutdown path.
process.argv.splice(2, 0, 'serve');
await import('../../scripts/manage.js');
export {};
