function getCurrentUser(req) {
  return req.session && req.session.user ? req.session.user : null;
}

function requireLogin(req, res, next) {
  const user = getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ message: "请先登录。" });
  }

  req.currentUser = user;
  next();
}

function requireRole() {
  const roles = Array.prototype.slice.call(arguments);

  return function roleGuard(req, res, next) {
    const user = getCurrentUser(req);
    if (!user) {
      return res.status(401).json({ message: "请先登录。" });
    }

    if (roles.length && roles.indexOf(user.role) === -1) {
      return res.status(403).json({ message: "没有权限执行当前操作。" });
    }

    req.currentUser = user;
    next();
  };
}

module.exports = {
  getCurrentUser,
  requireLogin,
  requireRole,
};
