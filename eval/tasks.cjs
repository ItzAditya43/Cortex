// Benchmark tasks for the agent loop.
//
// Each task builds a throwaway workspace, gives the agent one prompt, and
// then checks the RESULTING FILES rather than what the agent said about
// them. That distinction is the whole point: an agent that explains a
// correct patch but never writes it scores zero here, which is exactly the
// failure mode that kept slipping through before.
//
// A task is:
//   name    unique id
//   tags    for filtering (edit, create, multi, search, refactor, ...)
//   files   {relative path: contents} written into a temp workspace
//   prompt  what the user would type
//   check(dir) -> true | string   true = pass, string = reason it failed

'use strict';

const fs = require('fs');
const path = require('path');

const read = (dir, p) => {
  try {
    return fs.readFileSync(path.join(dir, p), 'utf8');
  } catch {
    return null;
  }
};
const exists = (dir, p) => fs.existsSync(path.join(dir, p));

const tasks = [
  {
    name: 'create-file',
    tags: ['create'],
    files: {},
    prompt: 'Create a file called greet.js containing a function named greet that takes a name and returns the string "Hello, <name>!".',
    check: (dir) => {
      const src = read(dir, 'greet.js');
      if (!src) return 'greet.js was not created';
      if (!/function\s+greet|greet\s*=\s*(\(|function)/.test(src)) return 'no greet function found';
      if (!/Hello/.test(src)) return 'does not produce a Hello string';
      return true;
    },
  },

  {
    name: 'edit-single-line',
    tags: ['edit'],
    files: { 'config.js': 'module.exports = {\n  port: 3000,\n  host: "localhost",\n};\n' },
    prompt: 'In config.js change the port from 3000 to 8080. Change nothing else.',
    check: (dir) => {
      const src = read(dir, 'config.js');
      if (!src) return 'config.js missing';
      if (!/port:\s*8080/.test(src)) return 'port was not changed to 8080';
      if (!/host:\s*"localhost"/.test(src)) return 'host line was damaged';
      return true;
    },
  },

  {
    name: 'edit-preserve-indentation',
    tags: ['edit'],
    files: {
      'deep.js': 'class A {\n  run() {\n    if (true) {\n      return 1;\n    }\n  }\n}\n',
    },
    prompt: 'In deep.js, make run() return 42 instead of 1.',
    check: (dir) => {
      const src = read(dir, 'deep.js');
      if (!src) return 'deep.js missing';
      if (!/return 42/.test(src)) return 'did not return 42';
      if (!/^ {6}return 42;/m.test(src)) return 'indentation was not preserved (expected 6 spaces)';
      return true;
    },
  },

  {
    name: 'add-function-to-existing',
    tags: ['edit'],
    files: { 'math.js': 'function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n' },
    prompt: 'Add a subtract(a, b) function to math.js and export it alongside add.',
    check: (dir) => {
      const src = read(dir, 'math.js');
      if (!src) return 'math.js missing';
      if (!/function\s+subtract|subtract\s*=/.test(src)) return 'no subtract function';
      if (!/a\s*-\s*b/.test(src)) return 'subtract does not subtract';
      if (!/exports[\s\S]*subtract/.test(src)) return 'subtract not exported';
      if (!/exports[\s\S]*add/.test(src)) return 'add export was lost';
      return true;
    },
  },

  {
    name: 'multi-file-edit',
    tags: ['edit', 'multi'],
    files: {
      'a.js': 'const VERSION = "1.0.0";\nmodule.exports = { VERSION };\n',
      'b.js': 'const VERSION = "1.0.0";\nmodule.exports = { VERSION };\n',
    },
    prompt: 'Both a.js and b.js declare VERSION as "1.0.0". Update both to "2.0.0".',
    check: (dir) => {
      const a = read(dir, 'a.js');
      const b = read(dir, 'b.js');
      if (!a || !b) return 'a file went missing';
      if (!/2\.0\.0/.test(a)) return 'a.js not updated';
      if (!/2\.0\.0/.test(b)) return 'b.js not updated';
      return true;
    },
  },

  {
    name: 'find-then-fix',
    tags: ['search', 'edit'],
    files: {
      'src/util.js': 'function slugify(s) {\n  return s.toLowerCase();\n}\nmodule.exports = { slugify };\n',
      'src/other.js': 'const x = 1;\nmodule.exports = { x };\n',
      'README.md': '# demo\nUses slugify somewhere.\n',
    },
    prompt: 'Find the slugify function in this project and make it also replace spaces with hyphens.',
    check: (dir) => {
      const src = read(dir, 'src/util.js');
      if (!src) return 'src/util.js missing';
      if (!/replace|split|join/.test(src)) return 'no space-replacing logic added';
      if (!/-/.test(src)) return 'no hyphen present in the implementation';
      return true;
    },
  },

  {
    name: 'fix-syntax-error',
    tags: ['fix'],
    files: { 'broken.js': 'function hello() {\n  console.log("hi")\n\nmodule.exports = hello;\n' },
    prompt: 'broken.js has a syntax error — a missing closing brace. Fix it.',
    check: (dir) => {
      const src = read(dir, 'broken.js');
      if (!src) return 'broken.js missing';
      const opens = (src.match(/{/g) || []).length;
      const closes = (src.match(/}/g) || []).length;
      if (opens !== closes) return `braces still unbalanced (${opens} open, ${closes} close)`;
      return true;
    },
  },

  {
    name: 'no-op-when-already-correct',
    tags: ['restraint'],
    files: { 'fine.js': 'const PORT = 8080;\nmodule.exports = { PORT };\n' },
    prompt: 'Check whether fine.js sets PORT to 8080. If it already does, do not change anything — just tell me.',
    check: (dir) => {
      const src = read(dir, 'fine.js');
      if (src !== 'const PORT = 8080;\nmodule.exports = { PORT };\n') {
        return 'file was modified when it should have been left alone';
      }
      return true;
    },
  },

  {
    name: 'delete-file',
    tags: ['delete'],
    files: { 'keep.js': 'const a = 1;\n', 'remove-me.js': 'const b = 2;\n' },
    prompt: 'Delete the file remove-me.js. Leave keep.js alone.',
    check: (dir) => {
      if (exists(dir, 'remove-me.js')) return 'remove-me.js still exists';
      if (!exists(dir, 'keep.js')) return 'keep.js was wrongly deleted';
      return true;
    },
  },

  {
    name: 'rename-across-references',
    tags: ['refactor', 'multi'],
    files: {
      'lib.js': 'function oldName() {\n  return 1;\n}\nmodule.exports = { oldName };\n',
      'app.js': 'const { oldName } = require("./lib");\nconsole.log(oldName());\n',
    },
    prompt: 'Rename the function oldName to newName everywhere in this project, including where it is used.',
    check: (dir) => {
      const lib = read(dir, 'lib.js');
      const app = read(dir, 'app.js');
      if (!lib || !app) return 'a file went missing';
      if (/oldName/.test(lib) || /oldName/.test(app)) return 'oldName still referenced somewhere';
      if (!/newName/.test(lib)) return 'lib.js not renamed';
      if (!/newName/.test(app)) return 'app.js call site not updated';
      return true;
    },
  },

  {
    name: 'read-before-answer',
    tags: ['search'],
    files: {
      'data/secret.txt': 'the-answer-is-marmalade\n',
      'noise.js': 'const x = 1;\n',
    },
    prompt: 'There is a file under data/ containing a secret word. Read it and create answer.txt containing exactly that word.',
    check: (dir) => {
      const out = read(dir, 'answer.txt');
      if (!out) return 'answer.txt not created';
      if (!/marmalade/.test(out)) return `answer.txt does not contain the secret (got: ${out.trim().slice(0, 40)})`;
      return true;
    },
  },

  {
    name: 'append-not-overwrite',
    tags: ['edit', 'restraint'],
    files: { 'notes.md': '# Notes\n\n- existing point one\n- existing point two\n' },
    prompt: 'Add a third bullet "- third point" to notes.md, keeping the existing bullets.',
    check: (dir) => {
      const src = read(dir, 'notes.md');
      if (!src) return 'notes.md missing';
      if (!/existing point one/.test(src)) return 'existing content was destroyed';
      if (!/existing point two/.test(src)) return 'existing content was destroyed';
      if (!/third point/.test(src)) return 'third bullet not added';
      return true;
    },
  },
];

module.exports = { tasks };
