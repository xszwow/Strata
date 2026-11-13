function initChatLayout() {
    const root = document.documentElement;
    const app = document.body;
    const chat = document.getElementById('chat-container');
    const input = document.getElementById('user-input');
    const composer = document.querySelector('.input-area');
    const viewport = window.visualViewport;
    const isPinned = () =>
        chat.scrollHeight - chat.scrollTop - chat.clientHeight < 100;

    const resizeInput = () => {
        input.style.height = 'auto';
        input.style.height =
            Math.min(240, app.clientHeight * 0.35, input.scrollHeight) + 'px';
    };
    input.addEventListener('input', resizeInput);

    // Expanded composer content grows upward in normal flow. Reserve only the
    // persistent controls in the conversation, so disclosure never shifts history.
    let composerHeight = 0;
    const resizeComposer = () => {
        const expansion = [...composer.querySelectorAll('[data-composer-expansion]')]
            .reduce((height, node) => height + node.getBoundingClientRect().height, 0);
        const height = Math.ceil(composer.getBoundingClientRect().height - expansion);
        if (height === composerHeight) return;
        const pinned = isPinned();
        composerHeight = height;
        root.style.setProperty('--composer-height', height + 'px');
        if (pinned) chat.scrollTop = chat.scrollHeight;
    };
    new ResizeObserver(resizeComposer).observe(composer);

    let frame = 0;
    let appHeight = 0;
    let appWidth = 0;
    const syncViewport = () => {
        frame = 0;
        // Keep the layout unchanged during pinch zoom; the browser owns zooming and panning.
        if (viewport && Math.abs(viewport.scale - 1) > 0.05) return;
        const height = viewport?.height ?? window.innerHeight;
        const width = app.clientWidth;
        const top = viewport?.offsetTop ?? 0;
        root.style.setProperty('--app-top', top + 'px');
        if (height === appHeight && width === appWidth) return;
        const pinned = isPinned();
        appHeight = height;
        appWidth = width;
        root.style.setProperty('--app-height', height + 'px');
        resizeInput();
        resizeComposer();
        if (pinned) chat.scrollTop = chat.scrollHeight;
    };
    const scheduleViewport = () => {
        if (!frame) frame = requestAnimationFrame(syncViewport);
    };
    // Mobile keyboards can pan the visual viewport without changing its height.
    viewport?.addEventListener('resize', scheduleViewport);
    viewport?.addEventListener('scroll', scheduleViewport);
    window.addEventListener('resize', scheduleViewport);
    syncViewport();
}
