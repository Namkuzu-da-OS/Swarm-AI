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

    // Create Neural Globe
    const geometry = new THREE.IcosahedronGeometry(3, 2);
    const positions = geometry.attributes.position;

    // Wireframe
    const wireframeMaterial = new THREE.MeshBasicMaterial({
        color: 0x00f3ff,
        wireframe: true,
        transparent: true,
        opacity: 0.15
    });
    const wireframe = new THREE.Mesh(geometry, wireframeMaterial);
    scene.add(wireframe);

    // Particles at vertices
    const particlesGeometry = new THREE.BufferGeometry();
    const particlePositions = [];

    for (let i = 0; i < positions.count; i++) {
        particlePositions.push(
            positions.getX(i),
            positions.getY(i),
            positions.getZ(i)
        );
    }

    particlesGeometry.setAttribute('position', new THREE.Float32BufferAttribute(particlePositions, 3));

    const particlesMaterial = new THREE.PointsMaterial({
        color: 0x00f3ff,
        size: 0.1,
        transparent: true,
        opacity: 0.8
    });

    const particles = new THREE.Points(particlesGeometry, particlesMaterial);
    scene.add(particles);

    // Outer glow sphere
    const glowGeometry = new THREE.IcosahedronGeometry(3.2, 2);
    const glowMaterial = new THREE.MeshBasicMaterial({
        color: 0x00ff41,
        transparent: true,
        opacity: 0.05,
        side: THREE.BackSide
    });
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
    scene.add(glow);

    camera.position.z = 7;

    // Animation
    let pulsePhase = 0;
    const animate = () => {
        requestAnimationFrame(animate);

        // Rotate
        wireframe.rotation.y += 0.001;
        wireframe.rotation.x += 0.0005;
        particles.rotation.y += 0.001;
        particles.rotation.x += 0.0005;
        glow.rotation.y -= 0.0008;

        // Pulse
        pulsePhase += 0.01;
        const scale = 1 + Math.sin(pulsePhase) * 0.05;
        wireframe.scale.set(scale, scale, scale);
        particles.scale.set(scale, scale, scale);

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

// Initialize All
document.addEventListener('DOMContentLoaded', () => {
    initLenis();
    initThreeJS();
    initMissions();
});
