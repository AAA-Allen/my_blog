const axios = require("axios");

function getCallbackUrl() {
  return process.env.QQ_CALLBACK_URL || "http://localhost:4321/api/auth/qq/callback";
}

function ensureQQConfig() {
  if (!process.env.QQ_CLIENT_ID || !process.env.QQ_CLIENT_SECRET) {
    const error = new Error("QQ 登录尚未配置，请先设置 QQ_CLIENT_ID 和 QQ_CLIENT_SECRET。");
    error.statusCode = 500;
    throw error;
  }
}

function buildAuthorizeUrl(state) {
  ensureQQConfig();

  const query = new URLSearchParams({
    response_type: "code",
    client_id: process.env.QQ_CLIENT_ID,
    redirect_uri: getCallbackUrl(),
    scope: "get_user_info",
  });

  if (state) {
    query.set("state", state);
  }

  return "https://graph.qq.com/oauth2.0/authorize?" + query.toString();
}

async function fetchAccessToken(code) {
  ensureQQConfig();

  const response = await axios.get("https://graph.qq.com/oauth2.0/token", {
    params: {
      grant_type: "authorization_code",
      client_id: process.env.QQ_CLIENT_ID,
      client_secret: process.env.QQ_CLIENT_SECRET,
      code,
      redirect_uri: getCallbackUrl(),
    },
    responseType: "text",
  });

  const params = new URLSearchParams(String(response.data || ""));
  const accessToken = params.get("access_token");
  if (!accessToken) {
    const error = new Error("获取 QQ access_token 失败。");
    error.statusCode = 500;
    throw error;
  }

  return accessToken;
}

async function fetchOpenId(accessToken) {
  const response = await axios.get("https://graph.qq.com/oauth2.0/me", {
    params: { access_token: accessToken },
    responseType: "text",
  });

  const text = String(response.data || "");
  const matched = text.match(/"openid"\s*:\s*"([^"]+)"/);
  if (!matched) {
    const error = new Error("获取 QQ OpenID 失败。");
    error.statusCode = 500;
    throw error;
  }

  return matched[1];
}

async function fetchQQProfile(accessToken, openid) {
  const response = await axios.get("https://graph.qq.com/user/get_user_info", {
    params: {
      access_token: accessToken,
      oauth_consumer_key: process.env.QQ_CLIENT_ID,
      openid,
    },
  });

  const profile = response.data || {};
  return {
    openid,
    username: profile.nickname || "QQ用户",
    avatarUrl: profile.figureurl_qq_2 || profile.figureurl_qq_1 || profile.figureurl_2 || profile.figureurl_1 || "",
  };
}

async function exchangeCodeForProfile(code) {
  const accessToken = await fetchAccessToken(code);
  const openid = await fetchOpenId(accessToken);
  return fetchQQProfile(accessToken, openid);
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForProfile,
};
