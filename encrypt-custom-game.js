const path = require('path');
const crypto = require('crypto');
const glob = require('glob');
const micromatch = require('micromatch');
const fs = require('fs-extra');
const luamin = require('luamin');
const JavaScriptObfuscator = require('./javascript-obfuscator');
const { processCssFile } = require('./css-fuzzer');

const createMatcher = (patterns) => (file) => micromatch([file], patterns).length === 1;
const randomString = () => crypto.pseudoRandomBytes(32).toString('hex');

const config = require('./config');
const { debug = false } = config;
const key = Buffer.from(config.key, 'hex');

function encryptCode(code) {
  // code = luamin.minify(code);
  const iv = crypto.randomBytes(16);

  const codeByteLength = Buffer.from(code).length;
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([
    iv,
    cipher.update(code),
    cipher.update('\0'.repeat(16 - (codeByteLength % 16))),
    cipher.final(),
  ]);

  return encrypted.toString('hex');
}

function printLuaString(data) {
  let indent = '';
  while (data.includes(`]${indent}]`)) {
    indent += '=';
  }
  return `[${indent}[${data}]${indent}]`;
}

const clientLuaModules = [];
const isClientModule = createMatcher(config.vscripts.clientModules);
function registerClientModule(code) {
  const moduleId = randomString();
  clientLuaModules.push({ moduleId, code });
  return moduleId;
}

const isMatchingLuaModule = createMatcher(config.vscripts.patterns);
function processLuaModule(modulePath, code) {
  if (!isMatchingLuaModule(modulePath)) {
    // return luamin.minify(code);
    return code;
  }

  const serverCode = `return (decryptModule("${encryptCode(code)}", ...))`;
  if (isClientModule(modulePath)) {
    const moduleId = registerClientModule(code);
    const clientCode = `return assert(load(CustomNetTables:GetTableValue("encrypted_modules", "${moduleId}")._, debug.getinfo(1).source, nil, getfenv()))()`;
    return `if IsServer() then ${serverCode} else tryInitDecrypt();${clientCode} end`;
  } else {
    return serverCode;
  }
}

function generateAddonInit(originalCode) {
  const encryptedServerCode = `
    if ${debug} and not IsInToolsMode() then
      error("debug mode is enabled in production build")
    end

    local jsModules = {}
    ${panoramaModules
      .map(({ moduleId, code }) => `jsModules["${moduleId}"] = ${printLuaString(code)}`)
      .join('\n')}

    do
      local done = false
      ListenToGameEvent("npc_spawned", function()
        if not CustomNetTables or done then return end
        done = true

        CustomGameEventManager:RegisterListener("decrypt_panorama", function(_, event)
            local moduleId = event.m
            local code = jsModules[moduleId]
            local player = PlayerResource:GetPlayer(event.PlayerID)
            if player and code then
                CustomGameEventManager:Send_ServerToPlayer(player, "decrypt_panorama_" .. event.k, {c = code})
            end
        end)

        ${clientLuaModules
          .map(
            ({ moduleId, code }) =>
              `CustomNetTables:SetTableValue("encrypted_modules", "${moduleId}", {_=${printLuaString(
                code,
              )}})`,
          )
          .join('\n')}
      end, nil)
    end

    ${originalCode}
  `;

  const serverCode = `
    ${fs.readFileSync(path.join(__dirname, 'aes.lua'), 'utf8')}

    local function fromHex(s)
      return s:gsub('..', function (cc) return string.char(tonumber(cc, 16)) end)
    end

    local key = {string.byte(fromHex(${
      debug ? JSON.stringify(key.toString('hex')) : 'GetDedicatedServerKeyV2("encrypted_modules")'
    }), 1, 16)}

    _G.decrypt = function(encrypted)
      local raw = fromHex(encrypted)
      local iv = {string.byte(raw, 1, 16)}
      local decrypted = ciphermode.decryptString(key, raw:sub(17), ciphermode.decryptCBC, iv)
      return string.sub(decrypted, 1, string.find(decrypted, "\\0") - 1)
    end

    _G.decryptModule = function(encrypted, ...)
      return (assert(load(decrypt(encrypted), debug.getinfo(2).source, nil, getfenv(2)))(...))
    end

    decryptModule("${encryptCode(encryptedServerCode)}", ...)
  `;

  const clientAddonInitModuleId = registerClientModule(originalCode);
  const clientCode = `
    local done = false
    _G.tryInitDecrypt = function()
      if done or not CustomNetTables or not CustomNetTables:GetTableValue("encrypted_modules", "${clientAddonInitModuleId}") then return end
      done = true
      assert(load(CustomNetTables:GetTableValue("encrypted_modules", "${clientAddonInitModuleId}")._, debug.getinfo(1).source, nil, getfenv()))()
    end
    ListenToGameEvent("npc_spawned", tryInitDecrypt, nil)
  `;

  return luamin.minify(`if IsServer() then ${serverCode} else ${clientCode} end`);
}

function encryptLua(tempPath, outPath) {
  for (const fileName of glob.sync('**/*', { cwd: tempPath, nodir: true })) {
    if (fileName === 'addon_init.lua') continue;
    const fileInputPath = path.join(tempPath, fileName);
    const fileOutputPath = path.join(outPath, fileName);
    if (fileName.endsWith('.lua')) {
      const code = fs.readFileSync(path.join(tempPath, fileName), 'utf8');
      fs.outputFileSync(fileOutputPath, processLuaModule(fileName.replace(/\.lua$/, ''), code));
    } else {
      fs.copySync(fileInputPath, fileOutputPath);
    }
  }

  const addonInitPath = path.join(tempPath, 'addon_init.lua');
  fs.outputFileSync(
    path.join(outPath, 'addon_init.lua'),
    generateAddonInit(fs.existsSync(addonInitPath) ? fs.readFileSync(addonInitPath, 'utf8') : ''),
  );
}

const panoramaModules = [];
const isMatchingPanoramaModule = createMatcher(config.panorama.patterns);

const uniqueModuleIds = new Map();
const getUniqueModuleId = (filePath) =>
  uniqueModuleIds.get(filePath) || uniqueModuleIds.set(filePath, randomString()).get(filePath);

// function splitEvalLongString(code) {
//   const formattedCode =
//     '"' +
//     JSON.stringify(code)
//       .slice(1, -1)
//       .match(/.{0,256}/gu)
//       .slice(0, -1)
//       .join('\\\n') +
//     '"';
//   return `eval(${formattedCode})`;
// }

function obfuscateJs(code) {
  return JavaScriptObfuscator.obfuscate(code, {
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.4,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.2,
    debugProtection: false,
    debugProtectionInterval: false,
    identifierNamesGenerator: 'mangled',
    rotateStringArray: true,
    selfDefending: true,
    splitStrings: true,
    stringArray: true,
    stringArrayEncoding: 'rc4',
    stringArrayThreshold: 1,
    shuffleStringArray: true,
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
  }).getObfuscatedCode();
}

/** @param {string} code */
function evalCharCodes(code) {
  const chars = [...code].map((x) => x.codePointAt(0));
  let charsString = '';
  while (chars.length) {
    // Lines longer than about 4096 chars are syntactic errors
    charsString += chars.splice(0, 512).join(',') + ',\n';
  }

  return `eval([${charsString}].map(c=>String.fromCodePoint(c)).join(""))`;
}

function getPanoramaDecryptCode(moduleId, callbackExpression) {
  const input = `
    let k = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join('');
    GameEvents.Subscribe("decrypt_panorama_"+k, ({ c }) => ${callbackExpression});
    GameEvents.SendCustomGameEventToServer("decrypt_panorama", { k, m: "${moduleId}" });
  `;

  return evalCharCodes(
    JavaScriptObfuscator.obfuscate(input, {
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 1,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 1,
      debugProtection: true,
      debugProtectionInterval: false,
      disableConsoleOutput: true,
      identifierNamesGenerator: 'hexadecimal',
      rotateStringArray: true,
      selfDefending: true,
      splitStrings: true,
      splitStringsChunkLength: 2,
      stringArray: true,
      stringArrayEncoding: 'rc4',
      stringArrayThreshold: 1,
      shuffleStringArray: true,
      transformObjectKeys: true,
      unicodeEscapeSequence: true,
    }).getObfuscatedCode(),
  );
}

/** @param {string} code */
function processPanoramaModule(code, filePath) {
  if (filePath.endsWith('.js')) {
    return undefined;
  } else if (filePath.endsWith('.css')) {
    return undefined;
  } else if (filePath.endsWith('.xml')) {
    const referencedCssFiles = [...code.matchAll(/<include\s*src="file:\/\/{resources}\/(.+?\.css)"\s*\/\s*>/g)]
      .map(([, resourcePath]) => resourcePath)
      .filter(isMatchingPanoramaModule)
      .map((resourcePath) => path.join(panoramaTempPath, resourcePath));

    const scriptsToEncrypt = [];
    const layoutWithoutEncryptedScripts = code.replace(
      /<include\s*src="file:\/\/{resources}\/(.+?)"\s*\/\s*>/g,
      (fullMatch, /** @type {string} */ resourcePath) => {
        const absolutePath = path.join(panoramaTempPath, resourcePath);
        if (resourcePath.endsWith('.js') && isMatchingPanoramaModule(resourcePath)) {
          scriptsToEncrypt.push(absolutePath);
          return '';
        }

        if (resourcePath.endsWith('.css') && isMatchingPanoramaModule(resourcePath)) {
          const newCssPath = processCssFile(absolutePath, path.join(panoramaOutPath, resourcePath), referencedCssFiles);
          return fullMatch.replace(resourcePath, path.relative(panoramaOutPath, newCssPath).replace(/\\/g, '/'));
        }

        return fullMatch;
      },
    );

    const scriptBundle = scriptsToEncrypt
      .map((p) => fs.readFileSync(p, 'utf8'))
      .join('\n\n');
    const layoutWithScripts = layoutWithoutEncryptedScripts.replace(
      '</scripts>',
      `</scripts><script>${scriptBundle}</script>`,
      // `</scripts><script>${obfuscateJs(scriptBundle)}</script>`,
    );

    const moduleId = getUniqueModuleId(filePath);
    panoramaModules.push({ moduleId, code: layoutWithScripts });
    return `<root><script>${getPanoramaDecryptCode(
      moduleId,
      '$.GetContextPanel().BLoadLayoutFromString(c, true, false)',
    )}</script><Panel/></root>`;
  }
}

function encryptPanorama(tempPath, outPath) {
  for (const fileName of glob.sync('**/*', { cwd: tempPath, nodir: true })) {
    const fileInputPath = path.join(tempPath, fileName);
    const fileOutputPath = path.join(outPath, fileName);
    if (isMatchingPanoramaModule(fileName)) {
      const code = fs.readFileSync(fileInputPath, 'utf8');
      const result = processPanoramaModule(code, fileInputPath);
      if (result !== undefined) {
        fs.outputFileSync(fileOutputPath, result);
      }
    } else {
      fs.copySync(fileInputPath, fileOutputPath);
    }
  }
}

const moveDir = (from, to) => {
  try {
    fs.moveSync(from, to);
  } catch {
    fs.copySync(from, to);
    fs.removeSync(from);
  }
};

const panoramaOutPath = path.join(config.addonPath, 'content/panorama');
const panoramaTempPath = path.join(__dirname, '_temp_panorama');
const luaOutPath = path.join(config.addonPath, 'game/scripts/vscripts');
const luaTempPath = path.join(__dirname, '_temp_vscripts');
try {
  moveDir(panoramaOutPath, panoramaTempPath);
  encryptPanorama(panoramaTempPath, panoramaOutPath);

  moveDir(luaOutPath, luaTempPath);
  encryptLua(luaTempPath, luaOutPath);
} catch (error) {
  console.error(error);
} finally {
  if (!config.noRestore) {
    console.log('Files encrypted, press any key to reset to originals');
    process.stdin.setRawMode(true);
    process.stdin.once('data', () => {
      process.stdin.setRawMode(false);

      if (fs.existsSync(luaTempPath)) {
        fs.rmdirSync(luaOutPath, { recursive: true });
        moveDir(luaTempPath, luaOutPath);
      }

      if (fs.existsSync(panoramaTempPath)) {
        fs.rmdirSync(panoramaOutPath, { recursive: true });
        moveDir(panoramaTempPath, panoramaOutPath);
      }

      process.exit();
    });
  } else {
    fs.removeSync(panoramaTempPath);
    fs.removeSync(luaTempPath);
  }
}
