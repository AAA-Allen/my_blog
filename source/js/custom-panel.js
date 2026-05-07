(function () {
  var calendarState = {
    viewYear: 0,
    viewMonth: 0,
  };

  function mountPanel() {
    var panel = document.querySelector(".allen-feature-panel");
    if (!panel) return;

    var stickyLayout = document.querySelector("#aside-content .sticky_layout");
    var asideContent = document.querySelector("#aside-content");
    var target = stickyLayout || asideContent;

    if (target && panel.parentNode !== target) {
      target.insertBefore(panel, target.firstChild);
    }
  }

  function renderClock() {
    var timeNode = document.getElementById("allen-clock-time");
    var dateNode = document.getElementById("allen-clock-date");

    if (!timeNode || !dateNode) return;

    var now = new Date();
    var time = now.toLocaleTimeString("zh-CN", { hour12: false });
    var date = now.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
    });

    timeNode.textContent = time;
    dateNode.textContent = date;
  }

  function resetCalendarToToday() {
    var now = new Date();
    calendarState.viewYear = now.getFullYear();
    calendarState.viewMonth = now.getMonth();
  }

  function renderCalendar() {
    var monthNode = document.getElementById("allen-calendar-month");
    var dayNode = document.getElementById("allen-calendar-day");
    var gridNode = document.getElementById("allen-calendar-grid");

    if (!monthNode || !dayNode || !gridNode) return;

    var now = new Date();
    var year = calendarState.viewYear || now.getFullYear();
    var month = calendarState.viewMonth >= 0 ? calendarState.viewMonth : now.getMonth();
    var today = now.getDate();
    var firstDay = new Date(year, month, 1).getDay();
    var lastDate = new Date(year, month + 1, 0).getDate();

    calendarState.viewYear = year;
    calendarState.viewMonth = month;

    monthNode.textContent = new Date(year, month, 1).toLocaleDateString("zh-CN", {
      month: "long",
      year: "numeric",
    });
    dayNode.textContent = String(today).padStart(2, "0");

    var cells = [];

    for (var i = 0; i < firstDay; i += 1) {
      cells.push('<span class="allen-calendar__cell allen-calendar__cell--muted"></span>');
    }

    for (var date = 1; date <= lastDate; date += 1) {
      var isToday =
        date === today &&
        year === now.getFullYear() &&
        month === now.getMonth();
      var className = "allen-calendar__cell";

      if (isToday) {
        className += " allen-calendar__cell--today allen-calendar__cell--active";
      }

      cells.push('<span class="' + className + '">' + date + "</span>");
    }

    gridNode.innerHTML = cells.join("");
  }

  function bindCalendarEvents() {
    var prevNode = document.getElementById("allen-calendar-prev");
    var nextNode = document.getElementById("allen-calendar-next");

    if (prevNode && prevNode.dataset.bound !== "true") {
      prevNode.dataset.bound = "true";
      prevNode.addEventListener("click", function () {
        calendarState.viewMonth -= 1;
        if (calendarState.viewMonth < 0) {
          calendarState.viewMonth = 11;
          calendarState.viewYear -= 1;
        }
        renderCalendar();
      });
    }

    if (nextNode && nextNode.dataset.bound !== "true") {
      nextNode.dataset.bound = "true";
      nextNode.addEventListener("click", function () {
        calendarState.viewMonth += 1;
        if (calendarState.viewMonth > 11) {
          calendarState.viewMonth = 0;
          calendarState.viewYear += 1;
        }
        renderCalendar();
      });
    }
  }

  function bindWechatToggle() {
    var toggle = document.getElementById("allen-wechat-toggle");
    var box = document.getElementById("allen-wechat-box");

    if (!toggle || !box || toggle.dataset.bound === "true") return;

    toggle.dataset.bound = "true";
    toggle.addEventListener("click", function () {
      box.hidden = !box.hidden;
    });
  }

  function initAllenPanel() {
    mountPanel();
    renderClock();
    resetCalendarToToday();
    renderCalendar();
    bindCalendarEvents();
    bindWechatToggle();
  }

  initAllenPanel();

  if (window.__allenClockTimer) {
    window.clearInterval(window.__allenClockTimer);
  }

  window.__allenClockTimer = window.setInterval(renderClock, 1000);

  document.addEventListener("pjax:complete", initAllenPanel);
})();
