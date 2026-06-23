const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');

// Replacements to make
const replacements = [
  { from: /bg-blue-600/g, to: 'bg-oe-primary' },
  { from: /bg-blue-700/g, to: 'bg-oe-primary-dark' },
  { from: /bg-blue-500/g, to: 'bg-oe-primary' },
  { from: /hover:bg-blue-700/g, to: 'hover:bg-oe-primary-dark' },
  { from: /hover:bg-blue-600/g, to: 'hover:bg-oe-primary-dark' },
  { from: /hover:bg-blue-500/g, to: 'hover:bg-oe-primary-dark' },
  { from: /focus:ring-blue-500/g, to: 'focus:ring-oe-primary' },
  { from: /focus:ring-blue-600/g, to: 'focus:ring-oe-primary' },
  { from: /border-blue-600/g, to: 'border-oe-primary' },
  { from: /border-blue-500/g, to: 'border-oe-primary' },
  { from: /text-blue-600/g, to: 'text-oe-primary' },
  { from: /text-blue-700/g, to: 'text-oe-primary-dark' },
];

function processFile(filePath) {
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;
    
    replacements.forEach(({ from, to }) => {
      if (from.test(content)) {
        content = content.replace(from, to);
        modified = true;
      }
    });
    
    if (modified) {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`✅ Updated: ${filePath}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error(`❌ Error processing ${filePath}:`, error.message);
    return false;
  }
}

function walkDir(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  
  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      // Skip node_modules and other build directories
      if (!['node_modules', 'dist', 'build', '.git'].includes(file)) {
        walkDir(filePath, fileList);
      }
    } else if (file.endsWith('.tsx') || file.endsWith('.ts')) {
      fileList.push(filePath);
    }
  });
  
  return fileList;
}

console.log('🔄 Starting to replace blue button colors with theme primary colors...\n');

const files = walkDir(srcDir);
let updatedCount = 0;

files.forEach(file => {
  if (processFile(file)) {
    updatedCount++;
  }
});

console.log(`\n✅ Complete! Updated ${updatedCount} files.`);
