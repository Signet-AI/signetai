#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "SignetUnrealTypes.h"
#include "SignetAgentComponent.generated.h"

UCLASS(ClassGroup = (Signet), BlueprintType, Blueprintable, meta = (BlueprintSpawnableComponent))
class SIGNETUNREALRUNTIME_API USignetAgentComponent : public UActorComponent
{
	GENERATED_BODY()

public:
	USignetAgentComponent();

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Signet")
	FString AgentId;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Signet")
	FString WorldId = TEXT("default-world");

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Signet")
	FString DisplayName;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Signet")
	FString Role = TEXT("NPC");

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Signet")
	FString DefaultPlayerId;

	UFUNCTION(BlueprintCallable, Category = "Signet")
	FString GetResolvedAgentId() const;

	UFUNCTION(BlueprintCallable, Category = "Signet")
	FString GetResolvedDisplayName() const;

	UFUNCTION(BlueprintCallable, Category = "Signet")
	FSignetNpcIdentity MakeIdentity() const;

	UFUNCTION(BlueprintCallable, Category = "Signet")
	FSignetNpcEvent MakePlayerEvent(
		const FString& EventType,
		const FString& Summary,
		const FString& PlayerId,
		const FString& Transcript
	) const;
};
