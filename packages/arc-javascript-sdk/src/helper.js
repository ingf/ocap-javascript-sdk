const { print, parse } = require('graphql');
const crypto = require('crypto');
const { name } = require('../package.json');
const debug = require('debug')(name);

const md5 = key =>
  crypto
    .createHash('md5')
    .update(key)
    .digest('hex');

/**
 * Make a field filter fn
 *
 * @param {*} kind
 */
const getTypeFilter = kind => x => {
  if (x.type.ofType) {
    return x.type.ofType.kind === kind;
  }
  return x.type.kind === kind;
};

/**
 * get fields and its dependencies based on schema
 *
 * @param {*} type
 * @param {*} depth
 * @param {*} map
 * @returns
 */
const resolveFieldTree = (type, depth, map) => {
  const { fields } = type;
  const scalarFields = fields.filter(getTypeFilter('SCALAR')).map(x => ({ name: x.name }));

  if (depth >= 4) {
    return { scalar: scalarFields.filter(x => Boolean(x.name)) };
  }

  const objectFields = fields.filter(getTypeFilter('OBJECT')).map(x => {
    const subType = x.type.ofType ? x.type.ofType.name : x.type.name;
    return {
      type: x.type.kind,
      name: x.name,
      fields: resolveFieldTree(map[subType], depth + 1, map),
    };
  });

  return {
    scalar: scalarFields,
    object: objectFields,
  };
};

/**
 * make graphql query string based on field list
 *
 * @param {*} fields
 * @param {*} ignoreFields
 * @returns string
 */
/* eslint-disable indent */
const makeQuery = (fields, ignoreFields) => `
  ${fields.scalar
    .filter(x => ignoreFields.includes(x.path) === false)
    .map(x => x.name)
    .join('\n')}
  ${
    Array.isArray(fields.object)
      ? fields.object
	  .filter(x => (x.fields.scalar || []).length || (x.fields.object || []).length)
	  .filter(x => ignoreFields.includes(x.path) === false)
	  .map(x => `${x.name} {${makeQuery(x.fields, ignoreFields)}}`)
	  .join('\n')
      : ''
  }`;
/* eslint-enable indent */

/**
 * assemble graphql params
 *
 * @param {*} values
 * @param {*} specs
 * @returns string
 */
const formatArgs = (values, specs = {}) => {
  if (!values) {
    throw new Error('Empty args when generating graphql query');
  }

  const isRequiredMissing = Object.keys(specs).some(
    x => specs[x].type.kind === 'NON_NULL' && !values[x]
  );
  if (isRequiredMissing) {
    throw new Error('Missing required args when generating graphql query');
  }

  return Object.keys(values || {})
    .filter(x => specs[x])
    .map(x => {
      const type = specs[x].type.ofType ? specs[x].type.ofType.name : specs[x].type.name;
      const kind = specs[x].type.ofType ? specs[x].type.ofType.kind : specs[x].type.kind;
      let value = '';
      if (kind === 'SCALAR') {
	if (type === 'String') {
	  value = `"${values[x].toString()}"`;
	} else {
	  value = values[x].toString();
	}
      } else {
	value = JSON.stringify(values[x]);
      }

      // debug({ x, type, kind, spec: specs[x], value });
      return `${x}: ${value}`;
    })
    .join(', ');
};

/**
 * Add path for nested objects
 *
 * @param {*} fields
 * @param {string} [prefix='']
 */
const addFieldsPath = (fields, prefix = '') => {
  if (Array.isArray(fields.scalar)) {
    fields.scalar.forEach(x => {
      x.path = [prefix, x.name].filter(Boolean).join('.');
    });
  }

  if (Array.isArray(fields.object)) {
    fields.object.forEach(x => {
      x.path = [prefix, x.name].filter(Boolean).join('.');
      addFieldsPath(x.fields, x.path);
    });
  }
};

/**
 * generate methods for all queries found on RootQueryType
 *
 * @param {*} { types, rootName, ignoreFields, type }
 * @returns <queryName => queryGeneratorFn>
 */
const getGraphQLBuilders = ({ types, rootName, ignoreFields, type }) => {
  const map = types.reduce((map, x) => {
    if (x.name.startsWith('__') === false) {
      map[x.name] = x;
    }
    return map;
  }, {});

  const prefix = {
    query: '',
    mutation: 'mutation',
    subscription: 'subscription',
  }[type];

  return map[rootName].fields.reduce((fns, x) => {
    const fields = resolveFieldTree(map[x.type.name], 0, map);

    addFieldsPath(fields);
    // console.log(require('util').inspect(fields, { depth: 100 }));

    const args = x.args.reduce((obj, a) => {
      obj[a.name] = a;
      return obj;
    }, {});

    /* eslint-disable indent */
    const fn = values => {
      const argStr = x.args.length ? `${formatArgs(values, args)}` : '';
      return print(
	parse(`${prefix}{
	${x.name}${argStr ? `(${argStr})` : ''} {
	  ${makeQuery(fields, typeof ignoreFields === 'function' ? ignoreFields(x) : ignoreFields)}
	}
      }`)
      );
    };
    /* eslint-enable indent */

    debug('graphql.getQueryBuilder', x.name);

    fn.args = args;
    fns[x.name] = fn;
    return fns;
  }, {});
};

const getQueryBuilders = ({ types, rootName, ignoreFields }) =>
  getGraphQLBuilders({ types, rootName, ignoreFields, type: 'query' });

const getMutationBuilders = ({ types, rootName, ignoreFields }) =>
  getGraphQLBuilders({ types, rootName, ignoreFields, type: 'mutation' });

const getSubscriptionBuilders = ({ types, rootName, ignoreFields }) =>
  getGraphQLBuilders({ types, rootName, ignoreFields, type: 'subscription' });

module.exports = {
  getQueryBuilders,
  getMutationBuilders,
  getSubscriptionBuilders,
  getGraphQLBuilders,
  getTypeFilter,
  resolveFieldTree,
  makeQuery,
  formatArgs,
  md5,
};
