// ============================================
// SWARM-AI: The Living Graph
// Network visualization + interactions
// ============================================

// Network Graph Animation
class NetworkGraph {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.nodes = [];
        this.mouse = { x: null, y: null };
        this.nodeCount = 60;
        this.connectionDistance = 150;
        this.mouseRadius = 200;

        this.colors = {
            node: '#e8b87d',
            nodeDim: 'rgba(232, 184, 125, 0.3)',
            line: 'rgba(232, 184, 125, 0.08)',
            lineActive: 'rgba(232, 184, 125, 0.25)'
        };

        this.resize();
        this.init();
        this.bindEvents();
        this.animate();
    }

    resize() {
        this.width = this.canvas.width = window.innerWidth;
        this.height = this.canvas.height = window.innerHeight;
    }

    init() {
        this.nodes = [];
        for (let i = 0; i < this.nodeCount; i++) {
            this.nodes.push({
                x: Math.random() * this.width,
                y: Math.random() * this.height,
                vx: (Math.random() - 0.5) * 0.3,
                vy: (Math.random() - 0.5) * 0.3,
                radius: Math.random() * 2 + 1,
                pulse: Math.random() * Math.PI * 2
            });
        }
    }

    bindEvents() {
        window.addEventListener('resize', () => {
            this.resize();
        });

        window.addEventListener('mousemove', (e) => {
            this.mouse.x = e.clientX;
            this.mouse.y = e.clientY;
        });

        window.addEventListener('mouseout', () => {
            this.mouse.x = null;
            this.mouse.y = null;
        });
    }

    update() {
        for (let node of this.nodes) {
            // Drift
            node.x += node.vx;
            node.y += node.vy;

            // Pulse
            node.pulse += 0.02;

            // Bounce off edges
            if (node.x < 0 || node.x > this.width) node.vx *= -1;
            if (node.y < 0 || node.y > this.height) node.vy *= -1;

            // Keep in bounds
            node.x = Math.max(0, Math.min(this.width, node.x));
            node.y = Math.max(0, Math.min(this.height, node.y));

            // Mouse interaction - gentle attraction
            if (this.mouse.x !== null && this.mouse.y !== null) {
                const dx = this.mouse.x - node.x;
                const dy = this.mouse.y - node.y;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < this.mouseRadius) {
                    const force = (1 - dist / this.mouseRadius) * 0.02;
                    node.vx += dx * force * 0.01;
                    node.vy += dy * force * 0.01;
                }
            }

            // Damping
            node.vx *= 0.99;
            node.vy *= 0.99;
        }
    }

    draw() {
        this.ctx.clearRect(0, 0, this.width, this.height);

        // Draw connections
        for (let i = 0; i < this.nodes.length; i++) {
            for (let j = i + 1; j < this.nodes.length; j++) {
                const dx = this.nodes[i].x - this.nodes[j].x;
                const dy = this.nodes[i].y - this.nodes[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < this.connectionDistance) {
                    const opacity = 1 - dist / this.connectionDistance;

                    // Check if near mouse for brighter lines
                    let isNearMouse = false;
                    if (this.mouse.x !== null) {
                        const midX = (this.nodes[i].x + this.nodes[j].x) / 2;
                        const midY = (this.nodes[i].y + this.nodes[j].y) / 2;
                        const mouseDist = Math.sqrt(
                            (this.mouse.x - midX) ** 2 + (this.mouse.y - midY) ** 2
                        );
                        isNearMouse = mouseDist < this.mouseRadius;
                    }

                    this.ctx.beginPath();
                    this.ctx.moveTo(this.nodes[i].x, this.nodes[i].y);
                    this.ctx.lineTo(this.nodes[j].x, this.nodes[j].y);
                    this.ctx.strokeStyle = isNearMouse
                        ? `rgba(232, 184, 125, ${opacity * 0.3})`
                        : `rgba(232, 184, 125, ${opacity * 0.08})`;
                    this.ctx.lineWidth = isNearMouse ? 1 : 0.5;
                    this.ctx.stroke();
                }
            }
        }

        // Draw nodes
        for (let node of this.nodes) {
            const pulseSize = 1 + Math.sin(node.pulse) * 0.3;
            const size = node.radius * pulseSize;

            // Check if near mouse
            let isNearMouse = false;
            if (this.mouse.x !== null) {
                const dist = Math.sqrt(
                    (this.mouse.x - node.x) ** 2 + (this.mouse.y - node.y) ** 2
                );
                isNearMouse = dist < this.mouseRadius;
            }

            // Glow for nodes near mouse
            if (isNearMouse) {
                this.ctx.beginPath();
                this.ctx.arc(node.x, node.y, size * 3, 0, Math.PI * 2);
                this.ctx.fillStyle = 'rgba(232, 184, 125, 0.1)';
                this.ctx.fill();
            }

            // Node
            this.ctx.beginPath();
            this.ctx.arc(node.x, node.y, size, 0, Math.PI * 2);
            this.ctx.fillStyle = isNearMouse ? this.colors.node : this.colors.nodeDim;
            this.ctx.fill();
        }
    }

    animate() {
        this.update();
        this.draw();
        requestAnimationFrame(() => this.animate());
    }
}

// Initialize network
const initNetwork = () => {
    const canvas = document.getElementById('network-canvas');
    if (canvas) {
        new NetworkGraph(canvas);
    }
};

// Smooth scroll with Lenis
const initSmoothScroll = () => {
    const lenis = new Lenis({
        duration: 1.2,
        easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
    });

    function raf(time) {
        lenis.raf(time);
        requestAnimationFrame(raf);
    }

    requestAnimationFrame(raf);
};

// Reveal on scroll
const initReveal = () => {
    const elements = document.querySelectorAll('.reveal, .stagger');

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
            }
        });
    }, {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    });

    elements.forEach(el => observer.observe(el));
};

// GitHub Missions (no bounties)
const initMissions = async () => {
    const loading = document.getElementById('missions-loading');
    const grid = document.getElementById('missions-grid');
    const error = document.getElementById('missions-error');
    const filters = document.querySelectorAll('.filter-btn');

    if (!grid) return;

    const fetchMissions = async () => {
        const queries = [
            'label:"help wanted" state:open',
            'label:"good first issue" state:open'
        ];

        const responses = await Promise.all(
            queries.map(q =>
                fetch(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=updated&per_page=15`)
            )
        );

        const data = await Promise.all(responses.map(r => r.json()));
        const all = data.flatMap(d => d.items || []);
        const unique = [...new Map(all.map(i => [i.id, i])).values()];

        return unique.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 9);
    };

    const createCard = (issue) => {
        const labels = issue.labels.map(l => l.name.toLowerCase());
        const isHelp = labels.includes('help wanted');
        const isFirst = labels.includes('good first issue');

        const repo = issue.repository_url.split('/').slice(-2).join('/');
        const days = Math.floor((Date.now() - new Date(issue.updated_at)) / 86400000);
        const time = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days}d ago`;

        const escape = t => {
            const d = document.createElement('div');
            d.textContent = t;
            return d.innerHTML;
        };

        const desc = issue.body
            ? escape(issue.body.split('\n')[0].slice(0, 120)) + '...'
            : 'No description.';

        const card = document.createElement('div');
        card.className = 'mission-card';
        card.dataset.help = isHelp;
        card.dataset.first = isFirst;

        let labelHtml = '';
        if (isHelp) labelHtml += '<span class="mission-label help-wanted">Help Wanted</span>';
        if (isFirst) labelHtml += '<span class="mission-label good-first">Good First</span>';

        card.innerHTML = `
            <div class="mission-labels">${labelHtml}</div>
            <h3 class="mission-title">${escape(issue.title)}</h3>
            <p class="mission-repo">${escape(repo)}</p>
            <p class="mission-desc">${desc}</p>
            <div class="mission-footer">
                <span class="mission-meta">${issue.comments} comments · ${time}</span>
                <a href="${issue.html_url}" target="_blank" class="mission-link">View →</a>
            </div>
        `;

        return card;
    };

    const filter = (type) => {
        document.querySelectorAll('.mission-card').forEach(card => {
            const show = type === 'all' ||
                (type === 'help-wanted' && card.dataset.help === 'true') ||
                (type === 'good-first-issue' && card.dataset.first === 'true');
            card.style.display = show ? '' : 'none';
        });
    };

    filters.forEach(btn => {
        btn.addEventListener('click', () => {
            filters.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            filter(btn.dataset.filter);
        });
    });

    try {
        const missions = await fetchMissions();
        loading.style.display = 'none';
        grid.style.display = 'grid';
        missions.forEach(m => grid.appendChild(createCard(m)));
    } catch (e) {
        loading.style.display = 'none';
        error.style.display = 'block';
    }
};

// Init
document.addEventListener('DOMContentLoaded', () => {
    initNetwork();
    initSmoothScroll();
    initReveal();
    initMissions();
});
