async function init() {
  try {
    const session = await fetch("/api/session").then(r => r.json());

    if (session.ok) {
      enterApp(session.name, session.admin);
    } else {
      $("#loginGate").hidden = false;
      requestAnimationFrame(() => {
        $("#loginGate").classList.add("is-visible");
      });
    }
  } catch {
    $("#loginGate").hidden = false;
    requestAnimationFrame(() => {
      $("#loginGate").classList.add("is-visible");
    });
  }
}

function enterApp(name, admin = false) {
  const gate = $("#loginGate");
  const app = $("#app");

  gate.classList.add("is-leaving");

  setTimeout(() => {
    gate.hidden = true;
    gate.classList.remove("is-leaving");
  }, 420);

  app.hidden = false;
  app.classList.add("is-entering");

  $(".admin-download").hidden = !admin;

  setTimeout(() => {
    app.classList.remove("is-entering");
  }, 850);
}

$("#loginForm").addEventListener("submit", async event => {
  event.preventDefault();

  $("#loginError").hidden = true;

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: $("#loginName").value,
        password: $("#loginPassword").value
      })
    });

    let result;

    try {
      result = await response.json();
    } catch {
      result = {
        error: "The server returned an unreadable login response."
      };
    }

    if (!response.ok) {
      $("#loginError").textContent = result.error || "Login failed.";
      $("#loginError").hidden = false;
      return;
    }

    enterApp(result.name, result.admin);
  } catch {
    $("#loginError").textContent =
      "Unable to connect to the server. Please try again.";
    $("#loginError").hidden = false;
  }
});

$("#companyFile").addEventListener("change", async event => {
  const file = event.target.files?.[0];

  if (file) {
    await extract(file);
  }
});

async function extract(file) {
  clearError();

  if (
    file.type !== "application/pdf" &&
    !file.name.toLowerCase().endsWith(".pdf")
  ) {
    showError("Please upload a valid annual-report PDF.");
    return;
  }

  if (file.size > 45 * 1024 * 1024) {
    showError("This PDF is larger than the 45 MB upload limit.");
    return;
  }

  $("#app").classList.remove("report-loaded");
  $("#uploadStatus").classList.add("is-loading");
  $("#uploadStatus").textContent =
    `Extracting ${file.name}… This can take up to a few minutes.`;

  const form = new FormData();
  form.append("report", file);

  try {
    const response = await fetch(
      "/api/ai/extract-financials",
      {
        method: "POST",
        body: form
      }
    );

    const text = await response.text();

    let result;

    try {
      result = JSON.parse(text);
    } catch {
      throw new Error("Server returned an unreadable response.");
    }

    if (!response.ok) {
      throw new Error(
        result.error || `Extraction failed (${response.status}).`
      );
    }

    company = result.company;
    rows = calculateRows(
      Array.isArray(result.financials)
        ? result.financials
        : []
    );

    if (!rows.length) {
      throw new Error(
        "Gemini returned no usable financial years."
      );
    }

    render();

    $("#app").classList.add("report-loaded");
    $("#uploadStatus").classList.remove("is-loading");
    $("#uploadStatus").textContent =
      `${company.name}: ${rows.length} reporting year${
        rows.length === 1 ? "" : "s"
      } extracted successfully.`;

    $("#companyWorkspace").classList.add("workspace-enter");

    setTimeout(() => {
      $("#companyWorkspace").classList.remove("workspace-enter");
    }, 1000);

    setTimeout(() => {
      $("#companyWorkspace").scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    }, 80);

  } catch (error) {
    $("#uploadStatus").classList.remove("is-loading");

    showError(
      error.message ||
      "The report could not be extracted. Please try again."
    );

    $("#uploadStatus").textContent =
      "Extraction failed. Please try again.";
  }
}
