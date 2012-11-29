
module.exports = {
  endPoint : 'https://ssl.reddit.com/api/v1/access_token',
  grantType : "authorization_code",
  handler : {oauth2 : 'BASIC'},
  strict: true,
  authUrl : 'https://ssl.reddit.com/api/v1/authorize?response_type=code&scope=identity,read&state='+Math.random()
};
