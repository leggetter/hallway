var tokenz = require('tokenz');
var lconfig = require("lconfig");
if (!lconfig.authSecrets) lconfig.authSecrets = {crypt:"foo", sign:"bar"};

/* this needs to be an integration test
describe("tokenz", function() {
  before(tokenz.init);
  describe("token", function() {
    it("generated", function(done){
      tokenz.createAccessToken("foo","bar",{}, function(err, token){
        console.log(token);
        token.access_token.should.equal('0156df09');
        done();        
      })
    });
  });
});

*/