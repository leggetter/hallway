exports.ptype = 115; // must be unique per service, see dMap.js

exports.user = {
  id: function(data){ return data["openfly:userid"] && data["openfly:userid"][0]; }
}

exports.defaults = {
  self: 'user'
};
