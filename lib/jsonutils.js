var util = require('util');

module.exports.inspect = inspect;

// Better defaults for debugging
function inspect(obj, opts) {
	return util.inspect(obj, opts || {colors:true, depth:null})
}


// sortedStringify: Based on stringify-object, but forcing quotes and sorting keys
// https://github.com/yeoman/stringify-object
(function () {
	'use strict';

	module.exports.isObject = isObject;
	function isObject(val) {
		return val === Object(val);
	}

	module.exports.isEmpty = isEmpty;
	function isEmpty(val) {
		if (typeof val === 'number' || typeof val === 'boolean') {
			return false;
		}
		if (val === undefined || val === null) {
			return true;
		}
		if (Array.isArray(val) || typeof val === 'string') {
			return val.length === 0;
		}
		for (var key in val) {
			if (Object.prototype.hasOwnProperty.call(val, key)) {
				return false;
			}
		}
		return true;
	}

	module.exports.sortedStringify = sortedStringify;
	function sortedStringify (val, opts, pad) {
		var cache = [];

		return (function stringify(val, opts, pad) {
			var objKeys;
			opts = opts || {};
			opts.indent = opts.indent || '\t';
			pad = pad || '';

			if (typeof val === 'number' ||
				typeof val === 'boolean' ||
				val === null ||
				val === undefined) {
				return val;
			}

			if (val instanceof Date) {
				return '"' + val.toISOString() + '"';
			}

			if (Array.isArray(val)) {
				if (isEmpty(val)) {
					return '[]';
				}

				return '[\n' + val.map(function (el, i) {
					var eol = val.length - 1 === i ? '\n' : ',\n';
					return pad + opts.indent + stringify(el, opts, pad + opts.indent) + eol;
				}).join('') + pad + ']';
			}

			if (isObject(val)) {
				if (cache.indexOf(val) !== -1) {
					return '"[Circular]"';
				}

				if (isEmpty(val)) {
					return '{}';
				}

				cache.push(val);

				objKeys = Object.keys(val).sort();

				return '{\n' + objKeys.map(function (el, i) {
					var key = stringify(el, opts);
					var eol = objKeys.length - 1 === i ? '\n' : ',\n';
					return pad + opts.indent + key + ': ' + stringify(val[el], opts, pad + opts.indent) + eol;
				}).join('') + pad + '}';
			}

			return '"' + val.replace(/"/g, '\\\"') + '"';
		})(val, opts, pad);
	}
})();