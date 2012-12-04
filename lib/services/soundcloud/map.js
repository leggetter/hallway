exports.ptype = 117; // must be unique per service, see dMap.js

exports.profile = {
  id: function(data) {
    return data && data.id;
  }
};

exports.defaults = {
  self: 'profile'
};
