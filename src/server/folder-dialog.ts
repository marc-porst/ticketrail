import { spawn } from 'node:child_process';
import os from 'node:os';

/** How long an unanswered dialog is allowed to hold a request open. */
const TIMEOUT_MS = 5 * 60_000;

interface Attempt {
  command: string;
  args: string[];
}

/**
 * The native folder chooser for this platform. On macOS the System Events
 * activate is not decoration: without it the dialog opens behind the browser
 * window and looks like nothing happened.
 */
function attempts(): Attempt[] {
  const prompt = 'Choose a project folder for Ticketrail';

  if (process.platform === 'darwin') {
    return [
      {
        command: 'osascript',
        args: [
          '-e',
          'tell application "System Events" to activate',
          '-e',
          `POSIX path of (choose folder with prompt "${prompt}")`,
        ],
      },
    ];
  }

  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description = '${prompt}'`,
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
    ].join('; ');
    return [{ command: 'powershell', args: ['-NoProfile', '-STA', '-Command', script] }];
  }

  return [
    { command: 'zenity', args: ['--file-selection', '--directory', `--title=${prompt}`] },
    { command: 'kdialog', args: ['--getexistingdirectory', os.homedir()] },
  ];
}

class MissingDialogTool extends Error {}

function run({ command, args }: Attempt): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let out = '';
    let err = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      resolve(null);
    }, TIMEOUT_MS);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));

    child.on('error', (error) => {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      finish(() => reject(missing ? new MissingDialogTool(command) : error));
    });

    child.on('close', (code) => {
      finish(() => {
        const picked = out.trim();
        // Every one of these tools exits non-zero on cancel and prints nothing,
        // so an empty result is a cancellation rather than a failure.
        if (picked) return resolve(picked.replace(/\/+$/, ''));
        if (code === 0) return resolve(null);
        if (/cancel/i.test(err)) return resolve(null);
        resolve(null);
      });
    });
  });
}

/** Only one dialog at a time — a second click must not stack windows. */
let inFlight: Promise<string | null> | null = null;

async function open(): Promise<string | null> {
  const tried: string[] = [];
  for (const attempt of attempts()) {
    try {
      return await run(attempt);
    } catch (error) {
      if (!(error instanceof MissingDialogTool)) throw error;
      tried.push(attempt.command);
    }
  }
  throw new Error(
    `No folder picker is available on this machine (looked for ${tried.join(', ')}). Type the path instead.`,
  );
}

/** The absolute path the user chose, or null if they cancelled. */
export function chooseFolder(): Promise<string | null> {
  if (inFlight) return inFlight;
  inFlight = open().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
