
module.exports = {
  endPoint : 'https://launchpad.37signals.com/authorization/token',
  type : "web_server",
  handler : {oauth2 : 'POST'},
  strict: true,
  authUrl : 'https://launchpad.37signals.com/authorization/new?type=web_server'
};
