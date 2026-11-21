const listEl = document.getElementById('list');
const hintEl = document.getElementById('hint');

let state = { clips: [], active: null };
let capturing = null;   // 正在录制热键的 clip id

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function durText(c) {
  const sec = (c.count || 0) / (c.fps || 60);
  return (c.count || 0) + ' 帧 · ' + sec.toFixed(1) + ' 秒';
}

function render() {
  listEl.innerHTML = '';
  if (!state.clips.length) {
    listEl.innerHTML = '<div style="padding:20px;color:#8d8598">还没有素材，点下面「导入素材」加一个。</div>';
    return;
  }
  for (const c of state.clips) {
    const row = document.createElement('div');
    row.className = 'row' + (c.id === state.active ? ' active' : '');
    row.dataset.id = c.id;

    row.innerHTML =
      '<div>' +
        '<div class="name">' + esc(c.name) + '</div>' +
        '<div class="meta">' + durText(c) + '</div>' +
      '</div>' +
      '<input class="hk" readonly value="' + esc(c.hotkey || '未设置') + '" />' +
      '<div class="tools">' +
        '<button class="play">试播</button>' +
        '<button class="ren">改名</button>' +
        '<button class="del danger">删除</button>' +
      '</div>';

    // 点整行 = 设为当前素材
    row.addEventListener('click', async (e) => {
      if (e.target.closest('button') || e.target.closest('input')) return;
      await window.aemeath.setActiveClip(c.id);
      state.active = c.id;
      render();
      hintEl.textContent = '当前素材：' + c.name;
    });

    // 热键录制
    const hk = row.querySelector('.hk');
    hk.addEventListener('click', () => {
      capturing = c.id;
      hk.classList.add('capture');
      hk.value = '按下组合键…';
      hintEl.textContent = '请按下 Ctrl / Alt / Shift / Win + 某个键';
      hk.focus();
    });

    row.querySelector('.play').addEventListener('click', () => {
      window.aemeath.playClip(c.id);
      hintEl.textContent = '试播中：' + c.name;
    });

    // 行内改名
    row.querySelector('.ren').addEventListener('click', () => {
      const nameBox = row.querySelector('.name');
      const old = c.name;
      nameBox.innerHTML = '<input class="edit" value="' + esc(old) + '" />';
      const input = nameBox.querySelector('input');
      input.focus();
      input.select();
      let done = false;
      const commit = async (ok) => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        if (ok && v && v !== old) {
          await window.aemeath.renameClip(c.id, v);
          c.name = v;
        }
        render();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit(true);
        if (e.key === 'Escape') commit(false);
      });
      input.addEventListener('blur', () => commit(true));
      input.addEventListener('click', (e) => e.stopPropagation());
    });

    // 删除（两次确认）
    const delBtn = row.querySelector('.del');
    delBtn.addEventListener('click', async () => {
      if (!delBtn.dataset.armed) {
        delBtn.dataset.armed = '1';
        delBtn.textContent = '确定删除？';
        setTimeout(() => {
          if (!delBtn.isConnected) return;
          delBtn.dataset.armed = '';
          delBtn.textContent = '删除';
        }, 4000);
        return;
      }
      const res = await window.aemeath.deleteClip(c.id);
      if (res && res.ok) {
        await refresh();
        hintEl.textContent = '已删除：' + c.name;
      } else {
        hintEl.textContent = '删除失败：' + ((res && res.error) || '未知错误');
      }
    });

    listEl.appendChild(row);
  }
}

async function refresh() {
  const res = await window.aemeath.listClips();
  if (!res) return;
  state.clips = res.clips || [];
  state.active = res.active;
  render();
}

document.getElementById('import').addEventListener('click', async () => {
  hintEl.textContent = '选择素材文件夹…';
  const res = await window.aemeath.importClip();
  if (res && res.ok) {
    await refresh();
    if (res.warn) {
      hintEl.textContent = res.warn;
      hintEl.style.color = '#ffc46b';
      setTimeout(() => { hintEl.style.color = ''; }, 8000);
    } else {
      hintEl.textContent = '已导入：' + (res.name || '') + '（' + (res.seconds || 0).toFixed(1) + ' 秒）';
    }
  } else if (res && res.error) {
    hintEl.textContent = '导入失败：' + res.error;
  } else {
    hintEl.textContent = '已取消';
  }
});

document.getElementById('close').addEventListener('click', () => {
  window.aemeath.closeSettings();
});

// 热键捕获
window.addEventListener('keydown', async (e) => {
  if (!capturing) return;
  e.preventDefault();
  e.stopPropagation();
  if (['Control', 'Alt', 'Shift', 'Meta', 'CapsLock'].includes(e.key)) return;

  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');

  if (!mods.length) {
    hintEl.textContent = '热键必须包含 Ctrl / Alt / Shift / Win 中至少一个';
    return;
  }

  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  else if (key === 'Escape') key = 'Esc';
  else if (key === 'ArrowUp') key = 'Up';
  else if (key === 'ArrowDown') key = 'Down';
  else if (key === 'ArrowLeft') key = 'Left';
  else if (key === 'ArrowRight') key = 'Right';

  const accel = mods.join('+') + '+' + key;
  const id = capturing;
  capturing = null;
  const res = await window.aemeath.setClipHotkey(id, accel);
  if (res && res.ok) {
    hintEl.textContent = '热键已设置：' + accel;
  } else {
    hintEl.textContent = '设置失败：' + ((res && res.error) || '可能与其他程序冲突');
  }
  await refresh();
});

refresh();
