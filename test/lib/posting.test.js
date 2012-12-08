var mocha   = require('mocha');
var should  = require('should');
var browser = require('supertest');

var api = require('webservice').api;
var authManager = require('authManager');

// TODO: Faking a user through auth with an account and profiles is hard
xdescribe('Posting Out', function() {
  var access_token;

  beforeEach(function(done) {
    require('node-fakeweb').tearDown();
    access_token = "eNxbZoAnD1UuM7kvY96rhnnxlrc.ivihwGYD738b5e2cc4799f90410cc7cace0e99657eb085072598bb8e91dd93bf9eeae8c48cd457f49fdf0fe9cc5d914d5bfa284099c2af15f6eaa19facc1facc1f67cc5f";
    done();
  });

  function itValidatesServices(params) {
    it('responds with HTTP 400', function(done) {
      params.access_token = access_token;
      browser(api).
        post('/types/statuses').
        send(params).
        expect(400).
        end(done);
    });

    it('gives you an error message', function(done) {
      params.access_token = access_token;
      browser(api).
        post('/types/statuses').
        send(params).
        end(function(err, res) {
          if (err) return done(err);
          res.body.error.should.equal('Must include "services" parameter.');
          should.exist(res.body.error);
          done();
        });
    });
  }

  describe('when you forget the services parameter', function() {
    itValidatesServices({});
  });

  describe('when you pass an empty services paramter', function() {
    itValidatesServices({services: null});
    itValidatesServices({services: ''});
  });
});
