(function () {
  var weekNames = ["日", "一", "二", "三", "四", "五", "六"];
  var today = new Date();
  var calendarState = {
    year: today.getFullYear(),
    month: today.getMonth(),
  };

  function createCover(title, colorA, colorB) {
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">' +
      "<defs>" +
      '<linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">' +
      '<stop offset="0%" stop-color="' +
      colorA +
      '"/>' +
      '<stop offset="100%" stop-color="' +
      colorB +
      '"/>' +
      "</linearGradient>" +
      "</defs>" +
      '<rect width="240" height="240" rx="28" fill="url(#bg)"/>' +
      '<circle cx="120" cy="120" r="78" fill="rgba(255,255,255,0.18)"/>' +
      '<circle cx="120" cy="120" r="48" fill="rgba(7,12,24,0.34)"/>' +
      '<circle cx="120" cy="120" r="6" fill="rgba(255,255,255,0.85)"/>' +
      '<text x="50%" y="56%" text-anchor="middle" font-size="28" font-family="Arial" fill="white">' +
      title +
      "</text>" +
      "</svg>";

    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  function createMelodyTrack(notes, options) {
    var sampleRate = 22050;
    var secondsPerBeat = 60 / options.bpm;
    var volume = options.volume || 0.38;
    var samples = [];

    notes.forEach(function (note) {
      var duration = note.beats * secondsPerBeat;
      var totalSamples = Math.max(1, Math.floor(duration * sampleRate));
      var fadeSamples = Math.max(1, Math.floor(totalSamples * 0.12));

      for (var i = 0; i < totalSamples; i += 1) {
        var time = i / sampleRate;
        var fadeIn = Math.min(1, i / fadeSamples);
        var fadeOut = Math.min(1, (totalSamples - i) / fadeSamples);
        var envelope = fadeIn * fadeOut;
        var sample = 0;

        if (note.frequency > 0) {
          sample =
            Math.sin(2 * Math.PI * note.frequency * time) * 0.7 +
            Math.sin(2 * Math.PI * note.frequency * 2 * time) * 0.2 +
            Math.sin(2 * Math.PI * note.frequency * 0.5 * time) * 0.1;
        }

        samples.push(sample * envelope * volume);
      }
    });

    var pcmData = new Int16Array(samples.length);
    for (var j = 0; j < samples.length; j += 1) {
      pcmData[j] = Math.max(-1, Math.min(1, samples[j])) * 32767;
    }

    var buffer = new ArrayBuffer(44 + pcmData.length * 2);
    var view = new DataView(buffer);

    function writeString(offset, value) {
      for (var k = 0; k < value.length; k += 1) {
        view.setUint8(offset + k, value.charCodeAt(k));
      }
    }

    writeString(0, "RIFF");
    view.setUint32(4, 36 + pcmData.length * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, pcmData.length * 2, true);

    for (var n = 0; n < pcmData.length; n += 1) {
      view.setInt16(44 + n * 2, pcmData[n], true);
    }

    return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
  }

  var tracks = [
    {
      title: "Lemon",
      artist: "Prototype Mix",
      subtitle: "未闻花名的晚风，吹向银河彼岸。",
      src: createMelodyTrack(
        [
          { frequency: 392.0, beats: 0.6 },
          { frequency: 440.0, beats: 0.6 },
          { frequency: 523.25, beats: 0.8 },
          { frequency: 587.33, beats: 0.8 },
          { frequency: 523.25, beats: 0.7 },
          { frequency: 440.0, beats: 0.7 },
          { frequency: 392.0, beats: 1.1 },
          { frequency: 329.63, beats: 0.9 },
          { frequency: 349.23, beats: 0.9 },
          { frequency: 440.0, beats: 1.2 },
          { frequency: 0, beats: 0.3 },
        ],
        { bpm: 96 }
      ),
      cover: createCover("Lemon", "#59aefc", "#6f7eff"),
    },
    {
      title: "Starlight",
      artist: "Prototype Mix",
      subtitle: "繁星落在云层之上，城市开始发光。",
      src: createMelodyTrack(
        [
          { frequency: 523.25, beats: 0.7 },
          { frequency: 659.25, beats: 0.7 },
          { frequency: 783.99, beats: 0.8 },
          { frequency: 698.46, beats: 0.8 },
          { frequency: 659.25, beats: 0.7 },
          { frequency: 587.33, beats: 0.7 },
          { frequency: 523.25, beats: 1.1 },
          { frequency: 392.0, beats: 0.9 },
          { frequency: 440.0, beats: 0.9 },
          { frequency: 523.25, beats: 1.2 },
          { frequency: 0, beats: 0.3 },
        ],
        { bpm: 108 }
      ),
      cover: createCover("Star", "#ff9f7f", "#5d7cff"),
    },
    {
      title: "Night Ride",
      artist: "Prototype Mix",
      subtitle: "公路尽头的霓虹，仍在轻轻闪烁。",
      src: createMelodyTrack(
        [
          { frequency: 293.66, beats: 0.8 },
          { frequency: 349.23, beats: 0.8 },
          { frequency: 392.0, beats: 0.9 },
          { frequency: 440.0, beats: 0.9 },
          { frequency: 392.0, beats: 0.8 },
          { frequency: 349.23, beats: 0.8 },
          { frequency: 293.66, beats: 1.1 },
          { frequency: 261.63, beats: 0.9 },
          { frequency: 293.66, beats: 0.9 },
          { frequency: 349.23, beats: 1.2 },
          { frequency: 0, beats: 0.3 },
        ],
        { bpm: 102 }
      ),
      cover: createCover("Ride", "#29386a", "#9a5cff"),
    },
  ];

  var audio = document.getElementById("audioPlayer");
  var playerCard = document.getElementById("playerCard");
  var coverImage = document.getElementById("coverImage");
  var songTitle = document.getElementById("songTitle");
  var songArtist = document.getElementById("songArtist");
  var songSubtitle = document.getElementById("songSubtitle");
  var currentTime = document.getElementById("currentTime");
  var durationTime = document.getElementById("durationTime");
  var progressRange = document.getElementById("progressRange");
  var volumeRange = document.getElementById("volumeRange");
  var playButton = document.getElementById("playButton");
  var prevButton = document.getElementById("prevButton");
  var nextButton = document.getElementById("nextButton");
  var playlistToggle = document.getElementById("playlistToggle");
  var playlistPanel = document.getElementById("playlistPanel");
  var playlistItems = document.getElementById("playlistItems");

  var calendarWeek = document.getElementById("calendarWeek");
  var calendarGrid = document.getElementById("calendarGrid");
  var calendarMonth = document.getElementById("calendarMonth");
  var calendarDay = document.getElementById("calendarDay");
  var calendarPrev = document.getElementById("calendarPrev");
  var calendarNext = document.getElementById("calendarNext");

  var activeTrackIndex = 0;

  function formatTime(value) {
    if (!Number.isFinite(value)) return "00:00";
    var minute = Math.floor(value / 60);
    var second = Math.floor(value % 60);

    return String(minute).padStart(2, "0") + ":" + String(second).padStart(2, "0");
  }

  function updatePlayButton(isPlaying) {
    playButton.innerHTML = isPlaying
      ? '<i class="fa-solid fa-pause"></i>'
      : '<i class="fa-solid fa-play"></i>';
    playerCard.classList.toggle("is-playing", isPlaying);
  }

  function syncPlaylistState() {
    var items = playlistItems.querySelectorAll("li");

    items.forEach(function (item, index) {
      item.classList.toggle("is-active", index === activeTrackIndex);
    });
  }

  function loadTrack(index, shouldPlay) {
    activeTrackIndex = (index + tracks.length) % tracks.length;

    var track = tracks[activeTrackIndex];
    audio.src = track.src;
    songTitle.textContent = track.title;
    songArtist.textContent = track.artist;
    songSubtitle.textContent = track.subtitle;
    coverImage.src = track.cover;
    coverImage.alt = track.title + " 专辑封面";
    progressRange.value = 0;
    currentTime.textContent = "00:00";
    durationTime.textContent = "00:00";

    syncPlaylistState();

    if (shouldPlay) {
      audio.play().catch(function () {
        updatePlayButton(false);
      });
    } else {
      updatePlayButton(false);
    }
  }

  function renderPlaylist() {
    playlistItems.innerHTML = tracks
      .map(function (track, index) {
        return (
          '<li data-index="' +
          index +
          '">' +
          "<strong>" +
          track.title +
          "</strong>" +
          "<span>" +
          track.artist +
          "</span>" +
          "</li>"
        );
      })
      .join("");

    playlistItems.addEventListener("click", function (event) {
      var item = event.target.closest("li");
      if (!item) return;

      loadTrack(Number(item.dataset.index), true);
    });

    syncPlaylistState();
  }

  function renderCalendar() {
    var year = calendarState.year;
    var month = calendarState.month;
    var firstDay = new Date(year, month, 1).getDay();
    var lastDate = new Date(year, month + 1, 0).getDate();
    var cells = [];

    calendarMonth.textContent = year + "年" + (month + 1) + "月";
    calendarDay.textContent = String(today.getDate()).padStart(2, "0");
    calendarWeek.innerHTML = weekNames
      .map(function (dayName) {
        return "<span>" + dayName + "</span>";
      })
      .join("");

    for (var i = 0; i < firstDay; i += 1) {
      cells.push('<span class="is-ghost"></span>');
    }

    for (var date = 1; date <= lastDate; date += 1) {
      var isToday =
        year === today.getFullYear() &&
        month === today.getMonth() &&
        date === today.getDate();

      cells.push('<span class="' + (isToday ? "is-today" : "") + '">' + date + "</span>");
    }

    calendarGrid.innerHTML = cells.join("");
  }

  playlistToggle.addEventListener("click", function () {
    playlistPanel.hidden = !playlistPanel.hidden;
  });

  playButton.addEventListener("click", function () {
    if (audio.paused) {
      audio.play().catch(function () {
        updatePlayButton(false);
      });
      return;
    }

    audio.pause();
  });

  prevButton.addEventListener("click", function () {
    loadTrack(activeTrackIndex - 1, true);
  });

  nextButton.addEventListener("click", function () {
    loadTrack(activeTrackIndex + 1, true);
  });

  volumeRange.addEventListener("input", function () {
    audio.volume = Number(volumeRange.value) / 100;
  });

  progressRange.addEventListener("input", function () {
    if (!audio.duration) return;
    audio.currentTime = (Number(progressRange.value) / 100) * audio.duration;
  });

  audio.addEventListener("loadedmetadata", function () {
    durationTime.textContent = formatTime(audio.duration);
  });

  audio.addEventListener("timeupdate", function () {
    if (!audio.duration) return;

    currentTime.textContent = formatTime(audio.currentTime);
    progressRange.value = (audio.currentTime / audio.duration) * 100;
  });

  audio.addEventListener("play", function () {
    updatePlayButton(true);
  });

  audio.addEventListener("pause", function () {
    updatePlayButton(false);
  });

  audio.addEventListener("ended", function () {
    loadTrack(activeTrackIndex + 1, true);
  });

  calendarPrev.addEventListener("click", function () {
    calendarState.month -= 1;

    if (calendarState.month < 0) {
      calendarState.month = 11;
      calendarState.year -= 1;
    }

    renderCalendar();
  });

  calendarNext.addEventListener("click", function () {
    calendarState.month += 1;

    if (calendarState.month > 11) {
      calendarState.month = 0;
      calendarState.year += 1;
    }

    renderCalendar();
  });

  audio.volume = Number(volumeRange.value) / 100;
  renderPlaylist();
  renderCalendar();
  loadTrack(activeTrackIndex, false);
})();
