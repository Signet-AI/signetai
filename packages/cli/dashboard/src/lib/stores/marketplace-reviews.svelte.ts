import {
	type MarketplaceReview,
	type MarketplaceReviewTargetType,
	createMarketplaceReview,
	deleteMarketplaceReview,
	getMarketplaceReviewConfig,
	getMarketplaceReviews,
	syncMarketplaceReviews,
	updateMarketplaceReviewConfig,
} from "$lib/api";
import { toast } from "$lib/stores/toast.svelte";

const DISPLAY_NAME_KEY = "signet:marketplace:reviews:display-name";

function loadDisplayName(): string {
	try {
		return localStorage.getItem(DISPLAY_NAME_KEY) ?? "";
	} catch {
		return "";
	}
}

function saveDisplayName(value: string): void {
	try {
		localStorage.setItem(DISPLAY_NAME_KEY, value);
	} catch {
		// localStorage may be unavailable
	}
}

export const reviewsMarket = $state({
	targetType: null as MarketplaceReviewTargetType | null,
	targetId: null as string | null,
	targetLabel: "",
	canReview: false,
	reviewEligibilityReason: "Install or use this app before leaving a review.",

	loading: false,
	items: [] as MarketplaceReview[],
	total: 0,
	summary: { count: 0, avgRating: 0 },

	displayName: loadDisplayName(),
	rating: 5,
	title: "",
	body: "",
	submitting: false,

	configLoading: false,
	configSaving: false,
	syncing: false,
	configEnabled: false,
	configEndpointUrl: "",
	lastSyncAt: null as string | null,
	lastSyncError: null as string | null,
	pendingSync: 0,
});

export async function setReviewTarget(
	targetType: MarketplaceReviewTargetType,
	targetId: string,
	targetLabel: string,
	options?: {
		canReview?: boolean;
		reason?: string;
	},
): Promise<void> {
	const same =
		reviewsMarket.targetType === targetType &&
		reviewsMarket.targetId === targetId &&
		reviewsMarket.targetLabel === targetLabel;
	if (same) return;

	reviewsMarket.targetType = targetType;
	reviewsMarket.targetId = targetId;
	reviewsMarket.targetLabel = targetLabel;
	reviewsMarket.canReview = options?.canReview ?? false;
	reviewsMarket.reviewEligibilityReason = options?.reason ?? "Install or use this app before leaving a review.";
	await fetchTargetReviews();
}

export async function fetchTargetReviews(): Promise<void> {
	if (!reviewsMarket.targetType || !reviewsMarket.targetId) {
		reviewsMarket.items = [];
		reviewsMarket.total = 0;
		reviewsMarket.summary = { count: 0, avgRating: 0 };
		return;
	}

	reviewsMarket.loading = true;
	try {
		const data = await getMarketplaceReviews({
			targetType: reviewsMarket.targetType,
			targetId: reviewsMarket.targetId,
			limit: 50,
		});
		reviewsMarket.items = data.reviews;
		reviewsMarket.total = data.total;
		reviewsMarket.summary = data.summary;
	} finally {
		reviewsMarket.loading = false;
	}
}

export async function submitMarketplaceReview(): Promise<void> {
	if (!reviewsMarket.targetType || !reviewsMarket.targetId) {
		toast("Select an item before writing a review", "error");
		return;
	}

	if (!reviewsMarket.canReview) {
		toast(reviewsMarket.reviewEligibilityReason, "error");
		return;
	}

	const displayName = reviewsMarket.displayName.trim();
	const title = reviewsMarket.title.trim();
	const body = reviewsMarket.body.trim();
	if (!displayName || !title || !body) {
		toast("Display name, title, and review are required", "error");
		return;
	}

	reviewsMarket.submitting = true;
	try {
		const result = await createMarketplaceReview({
			targetType: reviewsMarket.targetType,
			targetId: reviewsMarket.targetId,
			displayName,
			rating: reviewsMarket.rating,
			title,
			body,
		});
		if (!result.success) {
			toast(result.error ?? "Failed to submit review", "error");
			return;
		}

		saveDisplayName(displayName);
		reviewsMarket.title = "";
		reviewsMarket.body = "";
		toast("Review posted", "success");
		await Promise.all([fetchTargetReviews(), loadMarketplaceReviewConfig()]);
	} finally {
		reviewsMarket.submitting = false;
	}
}

export async function removeMarketplaceReview(id: string): Promise<void> {
	const result = await deleteMarketplaceReview(id);
	if (!result.success) {
		toast(result.error ?? "Failed to delete review", "error");
		return;
	}
	toast("Review deleted", "success");
	await Promise.all([fetchTargetReviews(), loadMarketplaceReviewConfig()]);
}

export async function loadMarketplaceReviewConfig(): Promise<void> {
	reviewsMarket.configLoading = true;
	try {
		const config = await getMarketplaceReviewConfig();
		reviewsMarket.configEnabled = config.enabled;
		reviewsMarket.configEndpointUrl = config.endpointUrl;
		reviewsMarket.lastSyncAt = config.lastSyncAt;
		reviewsMarket.lastSyncError = config.lastSyncError;
		reviewsMarket.pendingSync = config.pending;
	} finally {
		reviewsMarket.configLoading = false;
	}
}

export async function saveMarketplaceReviewConfig(): Promise<void> {
	reviewsMarket.configSaving = true;
	try {
		const result = await updateMarketplaceReviewConfig({
			enabled: reviewsMarket.configEnabled,
			endpointUrl: reviewsMarket.configEndpointUrl,
		});
		if (!result.success || !result.config) {
			toast(result.error ?? "Failed to save review sync config", "error");
			return;
		}
		reviewsMarket.configEnabled = result.config.enabled;
		reviewsMarket.configEndpointUrl = result.config.endpointUrl;
		toast("Review sync config saved", "success");
	} finally {
		reviewsMarket.configSaving = false;
	}
}

export async function syncMarketplaceReviewsNow(): Promise<void> {
	reviewsMarket.syncing = true;
	try {
		const result = await syncMarketplaceReviews();
		if (!result.success) {
			toast(result.error ?? "Review sync failed", "error");
			await loadMarketplaceReviewConfig();
			return;
		}

		if (result.message) {
			toast(result.message, "success");
		} else {
			toast(`Synced ${result.synced ?? 0} reviews`, "success");
		}
		await loadMarketplaceReviewConfig();
	} finally {
		reviewsMarket.syncing = false;
	}
}
