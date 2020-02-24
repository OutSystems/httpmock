var assert = require('assert');
var http = require('http');
var server = require('../lib/httpmock.js');

describe('default config', function () {
  before(function () {
      server.listen();
  });

  after(function () {
      server.close();
  });

  it('should return 200', function (done) {
    http.get('http://localhost:8888', function (res) {
      assert.equal(200, res.statusCode);
      done();
    });
  });

  it('should say "No rule was matched"', function (done) {
    http.get('http://localhost:8888', function (res) {
      var data = '';

      res.on('data', function (chunk) {
        data += chunk;
      });

      res.on('end', function () {
        assert.equal('No rule was matched...', data);
        done();
      });
    });
  });
});