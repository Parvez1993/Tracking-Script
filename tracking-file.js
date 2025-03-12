(function () {
  // Auto-detect client ID from script tag
  const scriptTag =
    document.currentScript ||
    (function () {
      const scripts = document.getElementsByTagName("script");
      return scripts[scripts.length - 1];
    })();
  const scriptSrc = scriptTag.src || "";
  const clientIdMatch = scriptSrc.match(/[?&]client=([^&]*)/);

  // Configuration
  const CONFIG = {
    endpoint: "https://localhost:3000/api/collect",
    clientId: clientIdMatch
      ? decodeURIComponent(clientIdMatch[1])
      : "{{CLIENT_ID}}",
    sessionTimeoutMinutes: 30,
    cookieLifeDays: 365,
  };

  // Utility functions
  const utils = {
    generateUUID: function () {
      return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
        /[xy]/g,
        function (c) {
          const r = (Math.random() * 16) | 0;
          const v = c === "x" ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        }
      );
    },

    getCookie: function (name) {
      const value = `; ${document.cookie}`;
      const parts = value.split(`; ${name}=`);
      if (parts.length === 2) return parts.pop().split(";").shift();
    },

    setCookie: function (name, value, days) {
      let expires = "";
      if (days) {
        const date = new Date();
        date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
        expires = `; expires=${date.toUTCString()}`;
      }

      // Extract root domain for cross-subdomain tracking
      const hostname = window.location.hostname;
      let domain = "";

      // Don't set domain for localhost (for testing)
      if (hostname !== "localhost" && hostname !== "127.0.0.1") {
        const domainParts = hostname.split(".");
        if (domainParts.length > 1) {
          // Get the root domain (e.g., xyz.com from alpha.xyz.com)
          domain = `; domain=.${domainParts.slice(-2).join(".")}`;
        }
      }

      document.cookie = `${name}=${value}${expires}${domain}; path=/; SameSite=Lax`;
    },

    debounce: function (func, wait) {
      let timeout;
      return function () {
        const context = this;
        const args = arguments;
        clearTimeout(timeout);
        timeout = setTimeout(function () {
          func.apply(context, args);
        }, wait);
      };
    },
  };

  // Core tracker functionality
  const Tracker = {
    sessionId: null,
    visitorId: null,
    queue: [],
    sending: false,

    init: function () {
      // Get or create visitor ID (persistent)
      this.visitorId = utils.getCookie("_vid") || utils.generateUUID();
      utils.setCookie("_vid", this.visitorId, CONFIG.cookieLifeDays);

      // Get or create session ID (temporary)
      this.sessionId = utils.getCookie("_sid") || utils.generateUUID();
      utils.setCookie(
        "_sid",
        this.sessionId,
        (1 / 24) * (CONFIG.sessionTimeoutMinutes / 60)
      );

      // Set up event listeners
      this.setupEventListeners();

      // Refresh session cookie on activity
      this.setupSessionRefresh();

      // Track page visit automatically
      this.trackPageView();

      // Set up periodic queue processing
      setInterval(this.processQueue.bind(this), 1000);

      // Send data on page unload
      window.addEventListener("beforeunload", this.processQueue.bind(this));
    },

    setupSessionRefresh: function () {
      const refreshSession = () => {
        utils.setCookie(
          "_sid",
          this.sessionId,
          (1 / 24) * (CONFIG.sessionTimeoutMinutes / 60)
        );
      };

      // Refresh session cookie on any user activity
      ["click", "scroll", "mousemove", "keydown", "touchstart"].forEach(
        (eventType) => {
          window.addEventListener(
            eventType,
            utils.debounce(refreshSession, 1000),
            { passive: true }
          );
        }
      );
    },

    setupEventListeners: function () {
      // Set up form tracking
      document.addEventListener(
        "submit",
        (event) => {
          const form = event.target;
          if (form.tagName === "FORM") {
            this.trackFormSubmission(form);
          }
        },
        { passive: true, capture: true }
      );

      // Set up click tracking
      document.addEventListener(
        "click",
        (event) => {
          const element = event.target.closest('a, button, [role="button"]');
          if (!element) return;

          let type,
            data = {};

          if (element.tagName === "A") {
            type = "link_click";
            data = {
              href: element.href,
              text: element.innerText || element.textContent,
              id: element.id || "",
              classes: element.className || "",
            };
          } else {
            type = "button_click";
            data = {
              text: element.innerText || element.textContent,
              id: element.id || "",
              classes: element.className || "",
            };
          }

          this.trackEvent("click", type, data.text, JSON.stringify(data));
        },
        { passive: true, capture: true }
      );
    },

    createEventData: function (eventType, eventData = {}) {
      return {
        clientId: CONFIG.clientId,
        timestamp: new Date().toISOString(),
        visitorId: this.visitorId,
        sessionId: this.sessionId,
        userAgent: navigator.userAgent,
        url: window.location.href,
        referrer: document.referrer,
        eventType: eventType,
        eventData: eventData,
      };
    },

    addToQueue: function (data) {
      this.queue.push(data);
      // Try to process immediately if possible
      if (!this.sending) {
        this.processQueue();
      }
    },

    processQueue: function () {
      if (this.sending || this.queue.length === 0) return;

      this.sending = true;
      const batch = this.queue.splice(0, Math.min(10, this.queue.length));

      try {
        const jsonData = JSON.stringify(batch);
        const blob = new Blob([jsonData], { type: "application/json" });

        if (navigator.sendBeacon && batch.length <= 5) {
          // SendBeacon is best for small batches and page unload
          navigator.sendBeacon(CONFIG.endpoint, blob);
          this.sending = false;
        } else {
          // Use XHR for larger batches or when sendBeacon is not available
          const xhr = new XMLHttpRequest();
          xhr.open("POST", CONFIG.endpoint, true);
          xhr.setRequestHeader("Content-Type", "application/json");
          xhr.onreadystatechange = () => {
            if (xhr.readyState === 4) {
              this.sending = false;
              if (xhr.status !== 200 && xhr.status !== 201) {
                // On failure, put the data back in the queue
                this.queue = batch.concat(this.queue);
              }
              // Process more if available
              if (this.queue.length > 0) {
                setTimeout(this.processQueue.bind(this), 50);
              }
            }
          };
          xhr.send(jsonData);
        }
      } catch (error) {
        // On error, put the data back in the queue
        this.queue = batch.concat(this.queue);
        this.sending = false;
        console.error("Error sending tracking data:", error);
      }
    },

    trackPageView: function () {
      const data = this.createEventData("pageview", {
        title: document.title,
        path: window.location.pathname,
        search: window.location.search,
        hash: window.location.hash,
      });
      this.addToQueue(data);
    },

    trackEvent: function (category, action, label, value) {
      const data = this.createEventData("event", {
        category: category,
        action: action,
        label: label || "",
        value: value || "",
      });
      this.addToQueue(data);
    },

    trackFormSubmission: function (form) {
      const formData = {};
      const elements = form.elements;
      const sensitiveFields = [
        "password",
        "card",
        "credit",
        "ccv",
        "cvv",
        "ssn",
        "social",
      ];

      for (let i = 0; i < elements.length; i++) {
        const element = elements[i];

        // Skip if no name or is a button
        if (
          !element.name ||
          element.type === "submit" ||
          element.type === "button"
        )
          continue;

        // Check if field may contain sensitive information
        const isSensitive =
          element.type === "password" ||
          sensitiveFields.some(
            (term) =>
              element.name.toLowerCase().includes(term) ||
              (element.id && element.id.toLowerCase().includes(term))
          );

        if (isSensitive) {
          // Only track that the field was filled, not the value
          formData[element.name] = element.value ? "(filled)" : "(empty)";
        } else {
          formData[element.name] =
            element.type === "checkbox"
              ? element.checked
              : element.value
              ? element.value.substring(0, 100)
              : "";
        }
      }

      const data = this.createEventData("form_submission", {
        formId: form.id || form.name || "unnamed_form",
        formAction: form.action,
        formMethod: form.method,
        formData: formData,
      });

      this.addToQueue(data);
    },
  };

  // Public API
  window.AdTracker = {
    trackEvent: function (category, action, label, value) {
      Tracker.trackEvent(category, action, label, value);
    },

    trackFormSubmission: function (formElement) {
      if (formElement && formElement.tagName === "FORM") {
        Tracker.trackFormSubmission(formElement);
      }
    },

    trackConversion: function (conversionType, value) {
      Tracker.trackEvent("conversion", conversionType, "", value);
    },

    getVisitorId: function () {
      return Tracker.visitorId;
    },

    getSessionId: function () {
      return Tracker.sessionId;
    },
  };

  // Initialize tracker
  Tracker.init();
})();
