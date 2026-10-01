export function namespaceDatabase(db, namespace, names) {
  if (!/^[a-f0-9]{64}$/.test(namespace)) throw new Error('Invalid database account.');
  const objects = new Set(names);
  const prefix = `u_${namespace}_`;
  const rewrite = (sql) => sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|\b[a-zA-Z_][a-zA-Z0-9_]*\b/g, (token) => {
    if (objects.has(token)) return prefix + token;
    if (/sqlite_(master|schema)/i.test(sql) && token.startsWith("'") && objects.has(token.slice(1, -1))) return `'${prefix}${token.slice(1, -1)}'`;
    if (token.startsWith('"') && objects.has(token.slice(1, -1))) return `"${prefix}${token.slice(1, -1)}"`;
    return token;
  }).replace(/(content\s*=\s*)'([^']+)'/gi, (match, assignment, name) => objects.has(name) ? `${assignment}'${prefix}${name}'` : match);
  return {
    exec: sql => db.exec(rewrite(sql)),
    prepare(sql) {
      const statement = db.prepare(rewrite(sql));
      if (!/sqlite_(master|schema)/i.test(sql)) return statement;
      const bind = args => args.map(value => objects.has(value) ? prefix + value : value);
      return {
        get: (...args) => statement.get(...bind(args)),
        all: (...args) => statement.all(...bind(args)),
        run: (...args) => statement.run(...bind(args)),
        iterate: (...args) => statement.iterate(...bind(args)),
      };
    },
    close: () => db.close(),
  };
}
