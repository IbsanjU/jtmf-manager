// ─── Login page logic ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // If already authenticated, go straight to app
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    if (data.authenticated) window.location.href = '/app';
  } catch (_) {}
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn     = document.getElementById('loginBtn');
  const btnText = document.getElementById('loginBtnText');
  const spinner = document.getElementById('loginBtnSpinner');
  const alert   = document.getElementById('loginAlert');

  const payload = {
    username:     document.getElementById('username').value.trim(),
    password:     document.getElementById('password').value.trim(),
    projectKey:   document.getElementById('projectKey').value.trim(),
    jiraUrl:      document.getElementById('jiraUrl').value.trim()
  };

  if (!payload.username || !payload.password || !payload.projectKey) {
    showAlert('Please fill in Project Key, Username, and Password.');
    return;
  }

  // Loading state
  btn.disabled  = true;
  btnText.textContent = 'Connecting…';
  spinner.style.display = 'inline-block';
  alert.style.display = 'none';

  try {
    const res  = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    window.location.href = '/app';
  } catch (err) {
    showAlert(err.message);
    btn.disabled  = false;
    btnText.textContent = 'Connect to JTMF';
    spinner.style.display = 'none';
  }
});

function showAlert(msg) {
  const el = document.getElementById('loginAlert');
  el.textContent = msg;
  el.style.display = 'block';
}

function togglePassword(inputId, btn) {
  const inp = document.getElementById(inputId);
  if (inp.type === 'password') {
    inp.type = 'text';
    btn.innerHTML = `<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/>
    </svg>`;
  } else {
    inp.type = 'password';
    btn.innerHTML = `<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
    </svg>`;
  }
}
