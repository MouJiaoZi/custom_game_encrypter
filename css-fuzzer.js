const fs = require('fs-extra');
const path = require('path');
const postcss = require('postcss');
const selectorParser = require('postcss-selector-parser');
const _ = require('lodash');
const prettier = require('prettier');
const config = require('./config');

function weightedSample(elements) {
  const items = Object.keys(elements);
  let chances = Object.values(elements);

  var sum = chances.reduce((acc, el) => acc + el, 0);
  var acc = 0;
  chances = chances.map((el) => (acc = el + acc));
  var rand = Math.random() * sum;
  return items[chances.filter((el) => el <= rand).length];
}

const oneOf = (...elements) => ({ oneOf: elements });
const ex = (value) => ({ exact: value });
const oneOfEx = (...values) => oneOf(...values.map(ex));
const declarationKinds = [
  { name: 'width', type: 'px', range: [0, 800] },
  { name: 'min-width', type: 'px', range: [0, 800] },
  { name: 'max-width', type: 'px', range: [0, 800] },
  { name: 'height', type: 'px', range: [0, 800] },
  { name: 'min-height', type: 'px', range: [0, 800] },
  { name: 'max-height', type: 'px', range: [0, 800] },
  { name: 'margin', type: oneOf(['px'], ['px'], ['px'], ['px', 'px']), range: [-20, 60] },
  { name: 'margin-left', type: 'px', range: [-20, 60] },
  { name: 'margin-right', type: 'px', range: [-20, 60] },
  { name: 'margin-top', type: 'px', range: [-20, 60] },
  { name: 'margin-bottom', type: 'px', range: [-20, 60] },

  { name: 'wash-color', type: 'color' },
  { name: 'color', type: 'color' },
  { name: 'background-color', type: 'color' },
  { name: 'box-shadow', type: ['color', 'px', 'px', 'px', 'px'], range: [-20, 20] },

  { name: 'align', type: [oneOfEx('left', 'center', 'right'), oneOfEx('bottom', 'center', 'top')] },
  { name: 'flow-children', type: oneOfEx('up', 'down', 'left', 'right') }, // TODO
  {
    name: 'transition-property',
    type: oneOfEx(
      'opacity',
      'position',
      'color',
      'background-color',
      'width',
      'height',
      'margin',
      'padding',
      'font-size',
      'font-weight',
    ),
  },
];

/** @param {import('postcss').Rule[]} realRules */
function generateFakeDeclaration(realRules) {
  const realDecls = realRules
    .flatMap((rule) => rule.nodes || [])
    .filter(/** @return {d is import('postcss').Declaration} */ (d) => d.type === 'rule');
  if (realDecls.length > 0 && Math.random() < 0.1) {
    return _.sample(realDecls);
  }

  const group = _.sample(declarationKinds);
  function resolveType(type) {
    if (typeof type === 'object' && 'oneOf' in type) {
      return resolveType(_.sample(type.oneOf));
    }

    if (Array.isArray(type)) {
      return type.map(resolveType).join(' ');
    }

    if (typeof type === 'object' && 'exact' in type) {
      return type.exact;
    }

    if (type === 'px') {
      return _.random(...(group.range || [-10, 100])) + 'px';
    }

    if (type === 'color') {
      var letters = '0123456789ABCDEF';
      var color = '#';
      for (var i = 0; i < 6; i++) {
        color += letters[Math.floor(Math.random() * 16)];
      }
      return Math.random() < 0.5 ? color : color.toLowerCase();
    }

    throw new Error(`Unknown type ${type} in ${group.name} rule`);
  }

  const value = resolveType(group.type);

  const decl = postcss.decl({
    prop: group.name,
    value,
    raws: { before: '\n\t' },
  });
  return decl;
}

const randomClassAndIdPostfixes = {
  container: 10,
  list: 10,
  items: 10,
  element: 5,
  elements: 5,
  children: 10,
  box: 10,
  panel: 10,
  label: 10,
  root: 10,
  hit: 10,
  icon: 10,
  wrap: 5,
  wrapper: 5,
  wrapped: 5,
  class: 5,
  new: 5,
  first: 2,
  last: 2,
};

const randomBaseClasses = {
  UiContainer: 10,
  MainRoot: 10,
  logo_el: 10,
  TextHeader: 10,
  duel: 10,
  Recentbets: 10,
  betwindow: 10,
  BetSlider: 10,
  Bet: 10,
  Players: 10,
  players: 10,
  gold: 10,
  Gold: 10,
  AbilityList: 5,
  PlayerHealth: 5,
  player_health: 5,
  team_group_left: 5,
  team_group_right: 5,
  duel_breakdown: 5,
  GameSkill: 5,
  roundRoot: 5,
  prepareRound: 5,
  RoundAutoReadyC: 5,
  freeList: 10,
  auto_ready: 10,
  Breaker: 5,
  game_core: 5,
  networt: 2,
};

/////////////////////////////////////
const randomParentClasses = {
  '': 90,
  HUDFlipped: 3,
  RankedGame: 3,
  map_ffa: 2,
  map_duos: 2,
};

const randomPseudoClasses = {
  '': 70,
  hover: 10,
  active: 3,
};

// const randomPanelNames = {
//   Panel: 40,
//   Label: 25,
//   Button: 25,
//   Image: 15,
//   DOTAHeroImage: 7,
//   DOTAItemImage: 7,
//   DOTAAbilityImage: 7,
//   ToggleButton: 8,
//   RadioButton: 5,
//   TextButton: 5,
//   TextEntry: 5,
//   DOTAScenePanel: 3,
//   DOTAPortrait: 3,
// };

const getClassNamesFromSelector = (selector) => {
  const classNames = [];
  selector.walkClasses(node => {
    classNames.push(node.value);
  });
  return classNames;
}

const getIdsFromSelector = (selector) => {
  const ids = [];
  selector.walkIds(node => {
    ids.push(node.value);
  });
  return ids;
}

/** @param {string} baseOn */
function generateFakeSelector(baseOn, context) {
  function updateSelector(rootSelector) {
    function addPostfixes(cls) {
      if (Math.random() < 0.85 || (baseOn && !context.isActual)) {
        const picked = weightedSample(randomClassAndIdPostfixes);
        if (cls.value === cls.value.toLowerCase()) {
          cls.value += '_' + picked;
        } else {
          cls.value += picked[0].toUpperCase() + picked.slice(1);
        }
      }
    }

    rootSelector.walkClasses(addPostfixes);
    rootSelector.walkIds(addPostfixes);

    for (const selector of rootSelector.nodes) {
      const parentClass = weightedSample(randomParentClasses);
      if (parentClass) {
        selector.replaceWith(
          selectorParser.selector({
            nodes: [
              selectorParser.className({ value: parentClass }),
              selectorParser.combinator({ value: ' ' }),
              selector,
            ],
          }),
        );
      }

      const pseudoClass = weightedSample(randomPseudoClasses);
      if (pseudoClass && !selector.toString().includes(':' + pseudoClass)) {
        selector.replaceWith(
          selectorParser.selector({
            nodes: [selector, selectorParser.pseudo({ value: ':' + pseudoClass })],
          }),
        );
      }
    }
  }

  return selectorParser((originalSelector) => {
    while(true) {
      const selector = originalSelector.clone();
      for (const node of selector.nodes) {
        if (node.nodes.length === 0 || (context.isActual && node.nodes.every(c => c.type === 'tag'))) {
          if (Math.random() < 0.6) {
            node.replaceWith(
              selectorParser.className({ value: weightedSample(randomBaseClasses) }),
            );
          } else {
            node.replaceWith(selectorParser.id({ value: weightedSample(randomBaseClasses) }));
          }
        }
      }

      updateSelector(selector);
      if (
        !getClassNamesFromSelector(selector).some(cn => context.usedClassNames.has(cn)) &&
        !getIdsFromSelector(selector).some(id => context.usedIds.has(id))
      ) {
        Object.assign(originalSelector, selector);
        break;
      }
    }
  }).processSync(baseOn || '');
}

/** @param {import('postcss').Rule[]} realRules */
function generateFakeRule(realRules, context) {
  const templateRule = _.sample(realRules);
  const maxRules = Math.max(...realRules.map((r) => r.nodes.length));
  const ruleCount = _.random(0, maxRules * 0.4) * 2 + _.random(1, 2);

  /** @type {import('postcss').Declaration[]} */
  let ruleDecls = [];
  for (let declIndex = 0; declIndex < ruleCount; declIndex++) {
    ruleDecls.push(generateFakeDeclaration(realRules));
  }

  // Usually run deduplicator, but rarely allow dupes
  if (Math.random() < 0.9) {
    ruleDecls = _.uniqBy(ruleDecls, (decl) => decl.prop);
  }

  return postcss.rule({
    // TODO:
    selector: generateFakeSelector(Math.random() < 0.08 ? templateRule.selector : '', context),
    // selector: generateFakeSelector('', context),
    raws: { before: '\n\n', semicolon: true },
    nodes: ruleDecls,
  });
}

function generateCss(context) {
  /** @type {import('postcss').AcceptedPlugin} */
  const plugin = (root) => {
    const realNodes = root.nodes;
    /** @type {import('postcss').Rule[]} */
    const realRules = root.nodes.filter(node => node.type === 'rule');

    root.nodes = [];
    for (const [, node] of realNodes.entries()) {
      let rulesBefore = _.random(5, 15);
      _.times(rulesBefore, () => root.nodes.push(generateFakeRule(realRules, context)));

      let rulesAfter = _.random(8, 24);

      // Include actual nodes in actual file or in fake with 4% chance
      if (context.isActual || Math.random() < 0.04) {
        node.raws.before = '\n\n';
        root.nodes.push(node);
      } else {
        rulesAfter += 1;
      }

      _.times(rulesAfter, () => root.nodes.push(generateFakeRule(realRules, context)));
    }
  };

  const postcssResult = postcss(plugin).process(context.source, { from: undefined });
  // const prettyResult = postcssResult.css.trim() + '\n';
  const prettyResult = prettier.format(postcssResult.css, { parser: 'css', useTabs: true });
  return prettyResult;
}

module.exports.processCssFile = function processCssFile(filePath, baseOutPath, allCssFiles) {
  const count = config.panorama.cssFiles;
  const actualIndex = config.debug ? 0 : _.random(0, count - 1);

  const context = createContext(filePath, allCssFiles);
  _.times(count, (i) => {
    const result = generateCss({ ...context, isActual: actualIndex === i });
    fs.outputFileSync(baseOutPath.replace(/\.css$/, `_${i}.css`), result);
  });

  return baseOutPath.replace(/\.css$/, `_${actualIndex}.css`);
};

function createContext(mainFile, allCssFiles) {
  const source = fs.readFileSync(mainFile, 'utf8')
    // .replace(/(?<=".*".*)\/\/.*$|(?<!".*)\/\/.*$/gm, '')
    .replace(/\/\*(.|[\r\n])*?\*\//g, '');

  const usedClassNames = new Set();
  const usedIds = new Set();

  for (const filePath of allCssFiles) {
    /** @type {import('postcss').AcceptedPlugin} */
    const plugin = (root) => {
      root.walkRules((rule) => {
        selectorParser((selector) => {
          getClassNamesFromSelector(selector).forEach(cn => usedClassNames.add(cn));
          getIdsFromSelector(selector).forEach(id => usedIds.add(id));
        }).processSync(rule.selector);
      });
    };

    postcss(plugin).process(
      fs.readFileSync(filePath, 'utf8')
        // .replace(/(?<=".*".*)\/\/.*$|(?<!".*)\/\/.*$/gm, '')
        .replace(/\/\*(.|[\r\n])*?\*\//g, ''),
      { from: undefined },
    ).css;
  }

  return { source, usedClassNames, usedIds, isActual: undefined };
}
