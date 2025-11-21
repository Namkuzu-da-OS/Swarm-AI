// --- 1. LENIS SMOOTH SCROLL ---
const initLenis = () => {
    const lenis = new Lenis({
        duration: 1.2,
        easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        smooth: true,
    });

    function raf(time) {
        lenis.raf(time);
        requestAnimationFrame(raf);
    }

    requestAnimationFrame(raf);
};

// --- 2. THREE.JS NEURAL GLOBE ---
const initThreeJS = () => {
    const container = document.getElementById('canvas-container');

    // Scene
    const scene = new THREE.Scene();
    // Fog for depth
    scene.fog = new THREE.FogExp2(0x030304, 0.02);

    // Camera
    const camera = new THREE.PerspectiveCamera(
        75,
        window.innerWidth / window.innerHeight,
        0.1,
        1000
    );

    // Renderer
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // Group to hold everything
    const group = new THREE.Group();
    scene.add(group);

    // Create Particles
    const particlesGeometry = new THREE.BufferGeometry();
    const particleCount = 700;
    const posArray = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount * 3; i++) {
        // Sphere distribution
        posArray[i] = (Math.random() - 0.5) * 10;
    }

    particlesGeometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));

    // Material for Particles - Electric Indigo
    const particlesMaterial = new THREE.PointsMaterial({
        size: 0.04,
        color: 0x4d4dff, // Electric Indigo
        transparent: true,
        opacity: 0.8,
    });

    // Mesh
    const particlesMesh = new THREE.Points(particlesGeometry, particlesMaterial);
    group.add(particlesMesh);

    // Secondary Particles - Fluorescent Mint
    const particlesGeometry2 = new THREE.BufferGeometry();
    const particleCount2 = 300;
    const posArray2 = new Float32Array(particleCount2 * 3);

    for (let i = 0; i < particleCount2 * 3; i++) {
        posArray2[i] = (Math.random() - 0.5) * 12;
    }

    particlesGeometry2.setAttribute('position', new THREE.BufferAttribute(posArray2, 3));

    const particlesMaterial2 = new THREE.PointsMaterial({
        size: 0.03,
        color: 0x00ff9d, // Mint
        transparent: true,
        opacity: 0.6,
    });

    const particlesMesh2 = new THREE.Points(particlesGeometry2, particlesMaterial2);
    group.add(particlesMesh2);

    camera.position.z = 4;

    // Mouse interaction
    let mouseX = 0;
    let mouseY = 0;

    window.addEventListener('mousemove', (event) => {
        mouseX = event.clientX / window.innerWidth - 0.5;
        mouseY = event.clientY / window.innerHeight - 0.5;
    });

    // Animation
    const animate = () => {
        requestAnimationFrame(animate);

        // Rotate entire group
        group.rotation.y += 0.002;
        group.rotation.x += 0.001;

        // Mouse parallax
        group.rotation.y += mouseX * 0.05;
        group.rotation.x += mouseY * 0.05;

        renderer.render(scene, camera);
    };

    animate();

    // Resize handler
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
};

// --- 4. GITHUB MISSIONS BOARD ---
const initMissions = async () => {
    const loadingEl = document.getElementById('missions-loading');
    const containerEl = document.getElementById('missions-container');
    const errorEl = document.getElementById('missions-error');
    const filterBtns = document.querySelectorAll('.filter-btn');

    let allMissions = [];
    let currentFilter = 'all';

    // Fetch issues from GitHub API
    const fetchMissions = async () => {
        try {
            // Search for issues with help-wanted, good-first-issue, or bounty labels
            const queries = [
                'label:"help wanted" state:open',
                'label:"good first issue" state:open',
                'bounty state:open type:issue'
            ];

            // Fetch all queries in parallel for better performance
            const responses = await Promise.all(
                queries.map(query =>
                    fetch(`https://api.github.com/search/issues?q=${encodeURIComponent(query)}&sort=updated&per_page=20`)
                )
            );

            // Check all responses are OK
            responses.forEach(response => {
                if (!response.ok) throw new Error('API request failed');
            });

            // Parse all JSON responses
            const dataArrays = await Promise.all(responses.map(r => r.json()));

            // Flatten all issues into single array
            const allIssues = dataArrays.flatMap(data => data.items);

            // Deduplicate by ID
            const uniqueIssues = Array.from(
                new Map(allIssues.map(issue => [issue.id, issue])).values()
            );

            // Sort by updated date
            return uniqueIssues.sort((a, b) =>
                new Date(b.updated_at) - new Date(a.updated_at)
            ).slice(0, 12); // Limit to 12 most recent

        } catch (error) {
            console.error('Error fetching missions:', error);
            throw error;
        }
    };

    // Create mission card HTML
    const createMissionCard = (issue) => {
        const labels = issue.labels.map(l => l.name.toLowerCase());
        const isBounty = labels.some(l => l.includes('bounty')) ||
            (issue.body && issue.body.toLowerCase().includes('$'));
        const isHelpWanted = labels.includes('help wanted');
        const isGoodFirstIssue = labels.includes('good first issue');

        const labelTags = [];
        if (isBounty) labelTags.push('<span class="mission-label label-bounty">💰 BOUNTY</span>');
        if (isHelpWanted) labelTags.push('<span class="mission-label label-help-wanted">HELP WANTED</span>');
        if (isGoodFirstIssue) labelTags.push('<span class="mission-label label-good-first-issue">GOOD FIRST</span>');

        // Extract repo name
        const repoFullName = issue.repository_url.split('/').slice(-2).join('/');

        // Sanitize and truncate description
        const escapeHtml = (text) => {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        };

        const desc = issue.body ?
            escapeHtml(issue.body.split('\n')[0].substring(0, 150)) + '...' :
            'No description provided.';

        // Calculate time ago
        const updatedDate = new Date(issue.updated_at);
        const daysAgo = Math.floor((Date.now() - updatedDate) / (1000 * 60 * 60 * 24));
        const timeAgo = daysAgo === 0 ? 'Today' :
            daysAgo === 1 ? 'Yesterday' :
                `${daysAgo} days ago`;

        const card = document.createElement('div');
        card.className = 'mission-card hover-target';
        card.dataset.labels = labels.join(',');
        card.dataset.isBounty = isBounty;
        card.dataset.isHelpWanted = isHelpWanted;
        card.dataset.isGoodFirstIssue = isGoodFirstIssue;

        card.innerHTML = `
            <div class="mission-header">
                <div class="mission-labels">
                    ${labelTags.join('')}
                </div>
            </div>
            <h3 class="mission-title">${escapeHtml(issue.title)}</h3>
            <div class="mission-repo">${escapeHtml(repoFullName)}</div>
            <p class="mission-description">${desc}</p>
            <div class="mission-footer">
                <div class="mission-meta">
                    <span>💬 ${issue.comments}</span>
                    <span>📅 ${timeAgo}</span>
                </div>
                <a href="${escapeHtml(issue.html_url)}" target="_blank" rel="noopener noreferrer" class="mission-link hover-target">VIEW →</a>
            </div>
        `;

        return card;
    };

    // Filter missions
    const filterMissions = (filter) => {
        const cards = containerEl.querySelectorAll('.mission-card');
        cards.forEach(card => {
            const shouldShow =
                filter === 'all' ||
                (filter === 'bounty' && card.dataset.isBounty === 'true') ||
                (filter === 'help-wanted' && card.dataset.isHelpWanted === 'true') ||
                (filter === 'good-first-issue' && card.dataset.isGoodFirstIssue === 'true');

            card.style.display = shouldShow ? 'block' : 'none';
        });
    };

    // Filter button handlers
    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            filterBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            filterMissions(currentFilter);
        });
    });

    // Load missions
    try {
        const missions = await fetchMissions();
        allMissions = missions;

        loadingEl.style.display = 'none';
        containerEl.style.display = 'grid';

        missions.forEach(issue => {
            const card = createMissionCard(issue);
            containerEl.appendChild(card);
        });

    } catch (error) {
        loadingEl.style.display = 'none';
        errorEl.style.display = 'block';
    }
};

// --- 5. CUSTOM CURSOR & MAGNETIC EFFECT ---
const initCursor = () => {
    const cursorDot = document.querySelector('.cursor-dot');
    const cursorOutline = document.querySelector('.cursor-outline');

    // Mouse movement
    window.addEventListener('mousemove', (e) => {
        const posX = e.clientX;
        const posY = e.clientY;

        // Dot follows instantly
        cursorDot.style.left = `${posX}px`;
        cursorDot.style.top = `${posY}px`;

        // Outline follows with delay (using animate for smoothness)
        cursorOutline.animate({
            left: `${posX}px`,
            top: `${posY}px`
        }, { duration: 500, fill: "forwards" });
    });

    // Hover effects
    const hoverTargets = document.querySelectorAll('.hover-target, a, button, .mission-card, .glass-panel');

    hoverTargets.forEach(target => {
        target.addEventListener('mouseenter', () => {
            cursorOutline.style.width = '60px';
            cursorOutline.style.height = '60px';
            cursorOutline.style.backgroundColor = 'rgba(77, 77, 255, 0.1)';
            cursorOutline.style.borderColor = 'transparent';
        });

        target.addEventListener('mouseleave', () => {
            cursorOutline.style.width = '40px';
            cursorOutline.style.height = '40px';
            cursorOutline.style.backgroundColor = 'transparent';
            cursorOutline.style.borderColor = 'var(--accent-secondary)';
        });
    });
};

// --- 6. SCROLL REVEAL ---
const initScrollReveal = () => {
    const reveals = document.querySelectorAll('.reveal');

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('active');
            }
        });
    }, {
        threshold: 0.1
    });

    reveals.forEach(reveal => observer.observe(reveal));
};

// Initialize All
document.addEventListener('DOMContentLoaded', () => {
    initLenis();
    initThreeJS();
    initMissions();
    initCursor();
    initScrollReveal();
});
