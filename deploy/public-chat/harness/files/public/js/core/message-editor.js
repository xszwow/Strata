// llama.cpp b11530 ChatMessageEditForm and editMessageWithBranching, adapted to
// this app's persisted message paths. Editing owns its draft and uploaded files.
const MessageEditor = {
    active: null,
    dispose() {
        if (this.active?.form.contains(Composer.anchor)) Composer.close();
        this.active = null;
    },
    control(icon, label, action, className = '') {
        const button = UI.button('', action, 'composer-control ' + className);
        button.setAttribute('aria-label', label);
        button.title = label;
        button.append(LlamaIcons.create(icon));
        return button;
    },
    open(chatId, messageId) {
        const state = MessageActions.current(chatId, messageId);
        if (!state || this.active || AppState.fileLoading) return;
        const wrapper = document.querySelector(`[data-message-id="${messageId}"]`);
        if (!wrapper || AppState.currentChatId !== chatId) return;
        const user = state.message.role === 'user';
        const form = document.createElement('form');
        form.className = 'message-editor';
        form.dataset.role = state.message.role;
        const editor = (this.active = {
            ...state,
            chatId,
            messageId,
            user,
            form,
            files: structuredClone(ChartPrompts.attachments(state.message)),
            loading: false,
            saving: false
        });
        editor.originalFiles = JSON.stringify(editor.files);
        wrapper.querySelector('.message').hidden = true;
        wrapper.querySelector('.message-footer').hidden = true;
        const composer = document.createElement('div');
        composer.className = 'input-container';
        editor.filesHost = document.createElement('div');
        editor.filesHost.className = 'message-edit-files';
        const textarea = (editor.input = document.createElement('textarea'));
        textarea.className = 'message-edit-input';
        textarea.setAttribute('aria-label', user ? '编辑你的消息' : '编辑回答');
        textarea.placeholder = '编辑你的消息…';
        textarea.value = state.message.content;
        const toolbar = document.createElement('div');
        toolbar.className = 'composer-toolbar message-edit-toolbar';
        if (user) {
            editor.fileInput = document.createElement('input');
            editor.fileInput.type = 'file';
            editor.fileInput.accept = '.docx,.xlsx,.xls,.pdf';
            editor.fileInput.multiple = true;
            editor.fileInput.hidden = true;
            editor.fileInput.className = 'message-edit-file-input';
            editor.fileInput.onchange = () => this.addFiles(editor, [...editor.fileInput.files]);
            editor.upload = this.control('plus', '添加附件', () => editor.fileInput.click(), 'composer-add');
            toolbar.append(editor.fileInput, editor.upload);
            const group = document.createElement('div');
            group.className = 'composer-tools';
            const modelTools = document.createElement('div');
            modelTools.className = 'composer-model-tools';
            editor.reasoning = this.control(
                'lightbulb',
                '推理强度',
                (event) => Composer.open('reasoning', event.currentTarget),
                'composer-reasoning'
            );
            editor.model = this.control(
                'package',
                '当前模型',
                (event) => Composer.open('model', event.currentTarget),
                'composer-model'
            );
            for (const button of [editor.reasoning, editor.model]) {
                button.setAttribute('aria-haspopup', 'dialog');
                button.setAttribute('aria-expanded', 'false');
                button.setAttribute('aria-controls', 'composer-panel');
                button.append(document.createElement('span'));
            }
            modelTools.append(editor.reasoning, editor.model);
            group.append(modelTools);
            toolbar.append(group);
        }
        editor.submit = this.control('arrow-up', user ? '发送修改' : '保存修改', null, 'composer-submit');
        editor.submit.type = 'submit';
        toolbar.append(editor.submit);
        editor.status = document.createElement('p');
        editor.status.className = 'message-edit-status';
        editor.status.setAttribute('role', 'status');
        editor.status.hidden = true;
        composer.append(editor.filesHost, textarea, editor.status, toolbar);
        const options = document.createElement('div');
        options.className = 'message-edit-options';
        const label = document.createElement('label');
        label.className = 'message-checkbox';
        editor.mode = document.createElement('input');
        editor.mode.type = 'checkbox';
        editor.mode.setAttribute('role', 'switch');
        editor.mode.onchange = () => this.update();
        label.append(editor.mode, user ? '仅更新，不重新发送' : '编辑后分支对话');
        options.append(
            label,
            UI.button('取消', () => this.cancel(editor), 'message-form-button')
        );
        form.append(composer, options);
        wrapper.prepend(form);
        textarea.oninput = () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(480, textarea.scrollHeight) + 'px';
            this.update();
        };
        form.onkeydown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                this.cancel(editor);
            } else if (event.target === textarea && Composer.shouldSubmit(event, textarea)) {
                event.preventDefault();
                if (!editor.submit.disabled) form.requestSubmit();
            }
        };
        form.onsubmit = (event) => {
            event.preventDefault();
            this.save(editor);
        };
        if (user) {
            form.ondragover = (event) => {
                if (event.dataTransfer.types.includes('Files')) event.preventDefault();
            };
            form.ondrop = (event) => {
                if (!event.dataTransfer.files.length) return;
                event.preventDefault();
                this.addFiles(editor, [...event.dataTransfer.files]);
            };
            textarea.onpaste = (event) => {
                if (!event.clipboardData.files.length) return;
                event.preventDefault();
                this.addFiles(editor, [...event.clipboardData.files]);
            };
        }
        this.renderFiles(editor);
        textarea.oninput();
        UI.updateControls();
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    },
    update() {
        const editor = this.active;
        if (!editor?.form.isConnected) return;
        const busy = editor.loading || editor.saving;
        editor.submit.disabled = busy || (!editor.input.value.trim() && !editor.files.length);
        editor.input.disabled = editor.saving;
        editor.mode.disabled = busy;
        editor.form
            .querySelectorAll('.message-edit-files button')
            .forEach((button) => (button.disabled = busy));
        if (editor.user) {
            const effort = Composer.effort(editor.chat);
            const bulb = effort === 'off' ? 'lightbulb-off' : 'lightbulb';
            if (editor.reasoning.querySelector('svg').dataset.icon !== bulb)
                editor.reasoning.querySelector('svg').replaceWith(LlamaIcons.create(bulb));
            editor.reasoning.dataset.default = effort === 'default';
            editor.reasoning.dataset.off = effort === 'off';
            editor.reasoning.querySelector('span').textContent =
                effort === 'default'
                    ? ''
                    : LlamaComposer.levels.find((level) => level.value === effort).label;
            editor.model.querySelector('span').textContent = Composer.model?.id || '模型信息未获取';
            editor.model.title = Composer.model?.id || '当前模型';
            editor.upload.disabled = busy;
            editor.reasoning.disabled = editor.saving;
            editor.model.disabled = editor.saving;
            const label = editor.mode.checked ? '保存修改' : '发送修改';
            editor.submit.setAttribute('aria-label', label);
            editor.submit.title = label;
        }
    },
    renderFiles(editor) {
        editor.filesHost.replaceChildren();
        editor.filesHost.hidden = !editor.files.length;
        editor.files.forEach((file, index) => {
            const chip = document.createElement('div');
            chip.className = 'composer-attachment';
            const preview = UI.button(
                file.fileName,
                () => UI.previewFile(file),
                'composer-control message-edit-file-name'
            );
            preview.title = file.fileName;
            const remove = this.control('x', '移除附件 ' + file.fileName, () => {
                editor.files.splice(index, 1);
                this.renderFiles(editor);
                this.update();
            });
            chip.append(preview, remove);
            editor.filesHost.append(chip);
        });
    },
    async addFiles(editor, files) {
        if (this.active !== editor || editor.loading || editor.saving || !files.length) return;
        editor.loading = true;
        editor.status.textContent = '正在读取附件…';
        editor.status.hidden = false;
        this.update();
        try {
            const parsed = [];
            for (const file of files) parsed.push(await parseAttachment(file));
            const total = [...editor.files, ...parsed].reduce((sum, file) => sum + file.content.length, 0);
            if (total > (AppState.user.maxInputChars || 150000) - ChartPrompts.system.length)
                throw new Error('附件文本总长度过长，请拆分');
            if (this.active !== editor || !editor.form.isConnected) return;
            editor.files.push(...parsed);
            this.renderFiles(editor);
            editor.status.hidden = true;
        } catch (error) {
            if (this.active === editor) editor.status.textContent = error.message;
        } finally {
            editor.loading = false;
            editor.fileInput.value = '';
            if (this.active === editor) this.update();
        }
    },
    cancel(editor) {
        if (this.active !== editor || editor.saving) return;
        const close = () => {
            if (this.active !== editor) return;
            const wrapper = editor.form.parentElement;
            this.dispose();
            editor.form.remove();
            wrapper.querySelector('.message').hidden = false;
            wrapper.querySelector('.message-footer').hidden = false;
            UI.updateControls();
            wrapper.querySelector('[aria-label="编辑"]')?.focus();
        };
        if (
            editor.input.value === editor.message.content &&
            JSON.stringify(editor.files) === editor.originalFiles &&
            !editor.loading
        )
            return close();
        MessageActions.dialog({
            title: '放弃修改？',
            description: '尚未保存的修改将丢失。',
            confirmLabel: '放弃修改',
            confirm: close
        });
    },
    async save(editor) {
        if (this.active !== editor || editor.loading || editor.saving || editor.submit.disabled) return;
        const state = MessageActions.current(editor.chatId, editor.messageId);
        if (!state || state.message !== editor.message || AppState.currentChatId !== editor.chatId) return;
        editor.saving = true;
        this.update();
        const { chat, index } = state;
        const regenerate = editor.user && !editor.mode.checked;
        const branch = editor.user ? regenerate && index < chat.messages.length - 1 : editor.mode.checked;
        const message = branch ? MessageActions.branch(chat, index) : state.message;
        message.content = editor.user ? editor.input.value.trim() : editor.input.value;
        message.attachment = editor.files.length === 1 ? structuredClone(editor.files[0]) : null;
        delete message.attachments;
        if (editor.files.length > 1) message.attachments = structuredClone(editor.files);
        message.edited = true;
        if (!editor.user) {
            message.chartFailures = [];
            message.status = 'complete';
            message.error = '';
            delete message.statistics;
        }
        this.dispose();
        if (regenerate) {
            const assistant = AppState.newMessage('assistant', '');
            chat.messages.push(assistant);
            await generateReply(chat, assistant);
        } else {
            await historyManager.persist(chat);
            if (AppState.currentChatId === chat.id) UI.renderChat();
        }
    }
};
