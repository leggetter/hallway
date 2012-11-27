exports.ptype = 116; // must be unique per service, see dMap.js

exports.authorization = {
  id: function(data){ return data && data.identity && data.identity.id; }
}
exports.defaults = {
  self: 'authorization'
};
