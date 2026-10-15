process.argv.splice(2, 0, 'backup');
await import('./manage.js');
export {};
