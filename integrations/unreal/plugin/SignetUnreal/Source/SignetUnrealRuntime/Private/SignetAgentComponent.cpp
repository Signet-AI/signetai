#include "SignetAgentComponent.h"

#include "GameFramework/Actor.h"

USignetAgentComponent::USignetAgentComponent()
{
	PrimaryComponentTick.bCanEverTick = false;
}

FString USignetAgentComponent::GetResolvedAgentId() const
{
	if (!AgentId.IsEmpty())
	{
		return AgentId;
	}

	const AActor* Owner = GetOwner();
	if (!Owner)
	{
		return TEXT("unreal-npc");
	}

	return Owner->GetName().ToLower().Replace(TEXT(" "), TEXT("-"));
}

FString USignetAgentComponent::GetResolvedDisplayName() const
{
	if (!DisplayName.IsEmpty())
	{
		return DisplayName;
	}

	const AActor* Owner = GetOwner();
	return Owner ? Owner->GetName() : GetResolvedAgentId();
}

FSignetNpcIdentity USignetAgentComponent::MakeIdentity() const
{
	FSignetNpcIdentity Identity;
	Identity.AgentId = GetResolvedAgentId();
	Identity.WorldId = WorldId.IsEmpty() ? TEXT("default-world") : WorldId;
	Identity.DisplayName = GetResolvedDisplayName();
	Identity.Role = Role.IsEmpty() ? TEXT("NPC") : Role;
	return Identity;
}

FSignetNpcEvent USignetAgentComponent::MakePlayerEvent(
	const FString& EventType,
	const FString& Summary,
	const FString& PlayerId,
	const FString& Transcript
) const
{
	FSignetNpcEvent Event;
	Event.AgentId = GetResolvedAgentId();
	Event.WorldId = WorldId.IsEmpty() ? TEXT("default-world") : WorldId;
	Event.PlayerId = PlayerId.IsEmpty() ? DefaultPlayerId : PlayerId;
	Event.EventType = EventType;
	Event.Summary = Summary;
	Event.Transcript = Transcript;
	Event.Scope = ESignetNpcEventScope::Player;
	return Event;
}
