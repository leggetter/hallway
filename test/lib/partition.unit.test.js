var partition = require("partition");
var lconfig = require("lconfig");
var should = require("should");

describe("Partition", function() {
  describe("readFrom", function() {
    it("returns one", function(done) {
      lconfig.partition = false;
      partition.init();
      partition.readFrom("type:foo@bar/", function(parts){
        parts.length.should.equal(1);
        parts[0].hash.should.equal("dca4b061252e7e8bf297a8e7c92d9ecd");
        done();
      });
    });
    it("returns two", function(done) {
      lconfig.partition = {size:2};
      partition.init();
      partition.readFrom("type:foo@bar/", function(parts){
        parts.length.should.equal(2);
        parts[0].table.should.equal("Entries_c8");
        done();
      });
    });
  });
});
