#include "SignetAsyncActions.h"

#include "Json.h"
#include "Misc/Guid.h"
#include "SignetUnrealClient.h"

namespace
{
constexpr int32 DefaultRecallLimit = 6;

FString BuildNpcIdentitySourceId(const FSignetNpcIdentity& Identity)
{
	return FString::Printf(TEXT("unreal:%s:%s:identity"), *Identity.WorldId, *Identity.AgentId);
}

FString BuildNpcEventId(const FSignetNpcEvent& Event)
{
	if (!Event.EventId.IsEmpty())
	{
		return Event.EventId;
	}
	return FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphensLower);
}

FString BuildNpcEventSourceId(const FSignetNpcEvent& Event)
{
	return FString::Printf(TEXT("unreal:%s:%s:%s"), *Event.WorldId, *Event.AgentId, *BuildNpcEventId(Event));
}

FString BuildNpcEventScope(const FSignetNpcEvent& Event)
{
	if (Event.Scope == ESignetNpcEventScope::Player && !Event.PlayerId.IsEmpty())
	{
		return FSignetUnrealClient::BuildPlayerScope(Event.WorldId, Event.PlayerId);
	}
	return FSignetUnrealClient::BuildWorldScope(Event.WorldId);
}

FString BuildIdentityContent(const FSignetNpcIdentity& Identity)
{
	return FString::Printf(
		TEXT("Unreal NPC agent identity. AgentId: %s. Display name: %s. Role: %s. World: %s."),
		*Identity.AgentId,
		*Identity.DisplayName,
		*Identity.Role,
		*Identity.WorldId
	);
}

FString BuildEventContent(const FSignetNpcEvent& Event)
{
	FString Content = FString::Printf(
		TEXT("Unreal NPC event. AgentId: %s. World: %s. Player: %s. Event type: %s. Summary: %s"),
		*Event.AgentId,
		*Event.WorldId,
		Event.PlayerId.IsEmpty() ? TEXT("none") : *Event.PlayerId,
		*Event.EventType,
		*Event.Summary
	);
	if (!Event.Transcript.IsEmpty())
	{
		Content += FString::Printf(TEXT("\nTranscript:\n%s"), *Event.Transcript);
	}
	return Content;
}

TSharedRef<FJsonObject> MakeRememberBody(
	const FString& AgentId,
	const FString& Scope,
	const FString& Content,
	const FString& SourceType,
	const FString& SourceId,
	float Importance,
	bool bPinned,
	const FString& Tags
)
{
	TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
	Body->SetStringField(TEXT("content"), Content);
	Body->SetStringField(TEXT("agentId"), AgentId);
	Body->SetStringField(TEXT("scope"), Scope);
	Body->SetStringField(TEXT("sourceType"), SourceType);
	Body->SetStringField(TEXT("sourceId"), SourceId);
	Body->SetStringField(TEXT("idempotencyKey"), SourceId);
	Body->SetStringField(TEXT("who"), TEXT("unreal"));
	Body->SetStringField(TEXT("tags"), Tags);
	Body->SetStringField(TEXT("visibility"), TEXT("global"));
	Body->SetNumberField(TEXT("importance"), FMath::Clamp(Importance, 0.0f, 1.0f));
	Body->SetBoolField(TEXT("pinned"), bPinned);
	return Body;
}

TSharedRef<FJsonObject> MakeRecallBody(const FString& AgentId, const FString& Scope, const FString& Query, int32 Limit)
{
	TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
	Body->SetStringField(TEXT("query"), Query);
	Body->SetStringField(TEXT("agentId"), AgentId);
	Body->SetStringField(TEXT("scope"), Scope);
	Body->SetNumberField(TEXT("limit"), FMath::Clamp(Limit, 1, 20));
	Body->SetBoolField(TEXT("includeRecalled"), true);
	return Body;
}

void ParseRecallResults(const TSharedPtr<FJsonObject>& Json, TArray<FSignetMemoryBlock>& OutMemories)
{
	if (!Json.IsValid())
	{
		return;
	}

	const TArray<TSharedPtr<FJsonValue>>* Results = nullptr;
	if (!Json->TryGetArrayField(TEXT("results"), Results) || !Results)
	{
		return;
	}

	for (const TSharedPtr<FJsonValue>& Value : *Results)
	{
		const TSharedPtr<FJsonObject> Row = Value.IsValid() ? Value->AsObject() : nullptr;
		if (!Row.IsValid())
		{
			continue;
		}

		FSignetMemoryBlock Block;
		Row->TryGetStringField(TEXT("id"), Block.Id);
		Row->TryGetStringField(TEXT("content"), Block.Content);
		Row->TryGetStringField(TEXT("type"), Block.Type);
		Row->TryGetStringField(TEXT("source"), Block.Source);
		Row->TryGetStringField(TEXT("created_at"), Block.CreatedAt);
		Row->TryGetStringField(TEXT("scope"), Block.Scope);

		double Score = 0.0;
		if (Row->TryGetNumberField(TEXT("score"), Score))
		{
			Block.Score = static_cast<float>(Score);
		}

		OutMemories.Add(Block);
	}
}

FString BuildPromptContext(const TArray<FSignetMemoryBlock>& Memories)
{
	TArray<FString> Lines;
	for (const FSignetMemoryBlock& Memory : Memories)
	{
		Lines.Add(FString::Printf(
			TEXT("- [%s %.2f] %s"),
			Memory.Type.IsEmpty() ? TEXT("memory") : *Memory.Type,
			Memory.Score,
			*Memory.Content.Replace(TEXT("\n"), TEXT(" "))
		));
	}
	return FString::Join(Lines, TEXT("\n"));
}
}

USignetHealthCheckAsync* USignetHealthCheckAsync::SignetHealthCheck(UObject* WorldContextObject)
{
	USignetHealthCheckAsync* Action = NewObject<USignetHealthCheckAsync>();
	Action->WorldContext = WorldContextObject;
	Action->RegisterWithGameInstance(WorldContextObject);
	return Action;
}

void USignetHealthCheckAsync::Activate()
{
	FSignetUnrealClient::GetJson(TEXT("/health"), [this](const FSignetOperationResult& Result, const TSharedPtr<FJsonObject>&)
	{
		Completed.Broadcast(Result);
		SetReadyToDestroy();
	});
}

USignetRegisterNpcAgentAsync* USignetRegisterNpcAgentAsync::RegisterSignetNpcAgent(
	UObject* WorldContextObject,
	FSignetNpcIdentity InIdentity
)
{
	USignetRegisterNpcAgentAsync* Action = NewObject<USignetRegisterNpcAgentAsync>();
	Action->WorldContext = WorldContextObject;
	Action->Identity = InIdentity;
	Action->RegisterWithGameInstance(WorldContextObject);
	return Action;
}

void USignetRegisterNpcAgentAsync::Activate()
{
	FSignetOperationResult Validation;
	if (Identity.AgentId.IsEmpty() || Identity.WorldId.IsEmpty())
	{
		Validation.Error = TEXT("AgentId and WorldId are required");
		Completed.Broadcast(Validation);
		SetReadyToDestroy();
		return;
	}

	const FString SourceId = BuildNpcIdentitySourceId(Identity);
	TSharedRef<FJsonObject> Body = MakeRememberBody(
		Identity.AgentId,
		FSignetUnrealClient::BuildWorldScope(Identity.WorldId),
		BuildIdentityContent(Identity),
		TEXT("unreal.npc_identity"),
		SourceId,
		0.9f,
		true,
		TEXT("unreal,npc,identity")
	);

	FSignetUnrealClient::PostJson(TEXT("/api/memory/remember"), Body, [this](const FSignetOperationResult& Result, const TSharedPtr<FJsonObject>&)
	{
		Completed.Broadcast(Result);
		SetReadyToDestroy();
	});
}

USignetObserveNpcEventAsync* USignetObserveNpcEventAsync::ObserveNpcEvent(UObject* WorldContextObject, FSignetNpcEvent InEvent)
{
	USignetObserveNpcEventAsync* Action = NewObject<USignetObserveNpcEventAsync>();
	Action->WorldContext = WorldContextObject;
	Action->Event = InEvent;
	Action->RegisterWithGameInstance(WorldContextObject);
	return Action;
}

void USignetObserveNpcEventAsync::Activate()
{
	FSignetOperationResult Validation;
	if (Event.AgentId.IsEmpty() || Event.WorldId.IsEmpty() || Event.Summary.IsEmpty())
	{
		Validation.Error = TEXT("AgentId, WorldId, and Summary are required");
		Completed.Broadcast(Validation);
		SetReadyToDestroy();
		return;
	}
	if (Event.Scope == ESignetNpcEventScope::Player && Event.PlayerId.IsEmpty())
	{
		Validation.Error = TEXT("PlayerId is required for player-scoped NPC events");
		Completed.Broadcast(Validation);
		SetReadyToDestroy();
		return;
	}

	TSharedRef<FJsonObject> Body = MakeRememberBody(
		Event.AgentId,
		BuildNpcEventScope(Event),
		BuildEventContent(Event),
		TEXT("unreal.npc_event"),
		BuildNpcEventSourceId(Event),
		Event.Importance,
		false,
		TEXT("unreal,npc,event")
	);

	FSignetUnrealClient::PostJson(TEXT("/api/memory/remember"), Body, [this](const FSignetOperationResult& Result, const TSharedPtr<FJsonObject>&)
	{
		Completed.Broadcast(Result);
		SetReadyToDestroy();
	});
}

USignetRecallNpcContextAsync* USignetRecallNpcContextAsync::RecallNpcContext(
	UObject* WorldContextObject,
	const FString& InAgentId,
	const FString& InWorldId,
	const FString& InPlayerId,
	const FString& InSituation,
	int32 InLimit
)
{
	USignetRecallNpcContextAsync* Action = NewObject<USignetRecallNpcContextAsync>();
	Action->WorldContext = WorldContextObject;
	Action->AgentId = InAgentId;
	Action->WorldId = InWorldId;
	Action->PlayerId = InPlayerId;
	Action->Situation = InSituation;
	Action->Limit = InLimit > 0 ? InLimit : DefaultRecallLimit;
	Action->RegisterWithGameInstance(WorldContextObject);
	return Action;
}

void USignetRecallNpcContextAsync::Activate()
{
	FSignetOperationResult Validation;
	if (AgentId.IsEmpty() || WorldId.IsEmpty() || Situation.IsEmpty())
	{
		Validation.Error = TEXT("AgentId, WorldId, and Situation are required");
		FinishRecall(Validation);
		return;
	}

	RecallScope(FSignetUnrealClient::BuildWorldScope(WorldId), [this](const FSignetOperationResult& WorldResult)
	{
		if (!WorldResult.bSuccess)
		{
			FinishRecall(WorldResult);
			return;
		}

		if (PlayerId.IsEmpty())
		{
			FinishRecall(WorldResult);
			return;
		}

		RecallScope(FSignetUnrealClient::BuildPlayerScope(WorldId, PlayerId), [this](const FSignetOperationResult& PlayerResult)
		{
			FinishRecall(PlayerResult);
		});
	});
}

void USignetRecallNpcContextAsync::RecallScope(const FString& Scope, TFunction<void(const FSignetOperationResult&)> Done)
{
	const FString Query = FString::Printf(
		TEXT("NPC %s needs context for situation: %s"),
		*AgentId,
		*Situation
	);
	TSharedRef<FJsonObject> Body = MakeRecallBody(AgentId, Scope, Query, Limit);

	FSignetUnrealClient::PostJson(
		TEXT("/api/memory/recall"),
		Body,
		[this, Done = MoveTemp(Done)](const FSignetOperationResult& Result, const TSharedPtr<FJsonObject>& Json) mutable
		{
			if (Result.bSuccess)
			{
				ParseRecallResults(Json, PendingMemories);
			}
			Done(Result);
		}
	);
}

void USignetRecallNpcContextAsync::FinishRecall(const FSignetOperationResult& Result)
{
	FSignetRecallContext Context;
	Context.Query = Situation;
	Context.Memories = PendingMemories;
	Context.PromptContext = BuildPromptContext(PendingMemories);
	Completed.Broadcast(Result, Context);
	SetReadyToDestroy();
}
