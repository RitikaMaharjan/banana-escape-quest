const form = document.getElementById('authForm');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const registerBtn = document.getElementById('registerBtn');
const message = document.getElementById('message');

function setMessage(text, kind) {
  message.textContent = text;
  message.className = kind || '';
}

async function send(path) {
  setMessage('Please wait...', 'info');
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: usernameInput.value.trim(),
        password: passwordInput.value,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      setMessage(data.error || 'Something went wrong.', 'error');
      return;
    }
    window.location.href = '/';
  } catch (err) {
    setMessage('Could not reach the server.', 'error');
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  send('/api/auth/login');
});

registerBtn.addEventListener('click', () => {
  if (!form.reportValidity()) return;
  send('/api/auth/register');
});

async function checkAlreadyLoggedIn() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) window.location.href = '/';
  } catch (err) {
    // Stay on the login page.
  }
}

checkAlreadyLoggedIn();
